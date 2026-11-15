"""EDUROAM "eduroam-tutor": ONE LiveKit agent that becomes whichever teacher the student picked.

* In-game call (voice-session): metadata = pairing id -> resolve -> that teacher, coursework, memory.
* FaceTime call (chert-webhook, shared Chert line): metadata = {"facetime_call": id} -> starts LOCKED,
  asks for the 6-digit code shown in EDUROAM, pair_with_code -> then the same teacher context.
* Gemini Live (realtime audio, interruptions) with live video input: the student's camera in the
  game, or the FaceTime caller's camera track when Chert's caller capture is enabled on the line.

Self-host (the LiveKit Cloud slot is held by the Agent Builder deployment "eduroam-tutor"):
    set LIVEKIT_AGENT_NAME_OVERRIDE=eduroam-tutor-code in agent/.env.local, run `python agent.py start`,
    and set the Supabase secret VOICE_AGENT_NAME=eduroam-tutor-code so voice-session dispatches here.
Run locally for development: `python agent.py dev` with another override name (e.g. eduroam-tutor-dev).
See BACKEND_HANDOFF.md, "In-game voice tutor: root cause + fix".
"""

from __future__ import annotations

import asyncio
import logging
import os

from livekit import rtc
from livekit.agents import Agent, AgentServer, AgentSession, ChatContext, JobContext, JobRequest, RunContext, function_tool, room_io
from livekit.plugins import google

from eduroam_backend import (
    Backend, BackendError, CallState, context_digest, fallback_summary, locked_instructions, paired_instructions, parse_metadata,
)

try:  # local development: agent/.env.local (never committed)
    from dotenv import load_dotenv

    load_dotenv(".env.local")
except ImportError:
    pass

logger = logging.getLogger("eduroam-tutor")
AGENT_NAME = "eduroam-tutor"
# Chert's bridge must name the agent's participant identity exactly (chert-webhook returns this).
AGENT_IDENTITY = "eduroam-tutor"


def backend() -> Backend:
    return Backend(os.environ.get("EDUROAM_VOICE_AGENT_URL", ""), os.environ.get("VOICE_AGENT_SECRET", ""), os.environ.get("SUPABASE_PUBLISHABLE_KEY"))


class Tutor(Agent):
    def __init__(self, state: CallState, api: Backend) -> None:
        self.state = state
        self.api = api
        super().__init__(instructions=paired_instructions(state) if state.paired else locked_instructions(state))

    async def refresh_instructions(self) -> None:
        await self.update_instructions(paired_instructions(self.state) if self.state.paired else locked_instructions(self.state))

    @function_tool()
    async def pair_with_code(self, context: RunContext, code: str) -> str:
        """FaceTime only: unlock this call with the 6-digit code the caller reads from EDUROAM.

        Args:
            code: the six digits the caller said, e.g. "482913".
        """
        if self.state.paired:
            return f"Already paired. You are {self.state.teacher}."
        if not self.state.dispatch.call_id:
            return "This call does not use codes."
        try:
            result = await self.api.pair(self.state.dispatch.call_id, code)
        except BackendError as err:
            if err.status == 400:
                return "That was not six digits. Ask them to read the 6-digit code again, one digit at a time."
            return f"Pairing is not possible on this call ({err.code}). Ask them to hang up and start again from EDUROAM."
        if not result.get("paired"):
            return f"Wrong or expired code. {result.get('attempts_left', 0)} tries left. Ask them to check the code in EDUROAM."
        self.state.pairing_id = result["pairing_id"]
        self.state.context = result
        await self.refresh_instructions()
        return (f"Paired. From now on you ARE {self.state.teacher}, the {result['npc']['subject']} teacher. "
                "Greet the student warmly in character, in one sentence, and ask what they want to work on.")

    @function_tool()
    async def get_npc_context(self, context: RunContext) -> dict:
        """Who you are (teacher name, subject, class), how this student likes to be taught, and what you remember about them."""
        if not self.state.paired:
            return {"locked": True, "message": "No EDUROAM code yet. Ask for the 6-digit code first."}
        return context_digest(self.state.context or {})

    @function_tool()
    async def search_coursework(self, context: RunContext, query: str) -> dict:
        """Search this student's uploaded coursework for this class (notes, worksheets, textbook pages).

        Args:
            query: what to look for, e.g. "power rule examples" or "worksheet question 3".
        """
        if not self.state.paired:
            return {"locked": True, "message": "No EDUROAM code yet."}
        try:
            return await self.api.search(self.state.pairing_id, query)
        except BackendError as err:
            return {"error": err.code, "message": "Coursework search is unavailable right now."}

    @function_tool()
    async def get_learning_progress(self, context: RunContext) -> dict:
        """This student's progress with you: what they studied last, what they mastered and what needs practice."""
        if not self.state.paired:
            return {"locked": True, "message": "No EDUROAM code yet."}
        try:
            return await self.api.progress(self.state.pairing_id)
        except BackendError as err:
            return {"error": err.code}

    @function_tool()
    async def save_session_summary(self, context: RunContext, summary: str, topics: list[str]) -> str:
        """Save what was studied on this call to the student's memory with you (call once, near the end).

        Args:
            summary: one or two sentences, e.g. "Practised the power rule; struggled with negative exponents, then got two right."
            topics: short topic names, e.g. ["power rule", "derivatives"].
        """
        if not self.state.paired:
            return "Nothing to save: this call was never paired."
        self.state.topics = [t for t in topics if isinstance(t, str)][:10]
        try:
            result = await self.api.end(self.state.pairing_id, summary, self.state.topics)
        except BackendError as err:
            return f"Could not save ({err.code})."
        self.state.summary_saved = True
        return "Saved." if result.get("saved") else f"Not saved ({result.get('reason')})."


async def summarize(session: AgentSession, teacher: str) -> tuple[str, list[str]]:
    """End of call without save_session_summary: a short learning summary (no raw transcript is stored)."""
    lines = []
    for item in session.history.items:
        text = getattr(item, "text_content", None)
        role = getattr(item, "role", "")
        if text and role in ("user", "assistant"):
            lines.append(f"{'Student' if role == 'user' else 'Tutor'}: {text}")
    if not lines:
        return "", []
    try:
        chat = ChatContext.empty()
        chat.add_message(role="system", content=(
            "Summarise this tutoring call for the tutor's memory in at most two sentences: what was practised, where the "
            "student struggled, what they got right. No names or personal details. Then a line 'TOPICS:' with up to three "
            "short comma-separated topics."))
        chat.add_message(role="user", content="\n".join(lines[-60:]))
        text = ""
        async with google.LLM(model=os.environ.get("SUMMARY_MODEL", "gemini-2.5-flash")).chat(chat_ctx=chat) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    text += chunk.delta.content
        summary, _, topic_line = text.partition("TOPICS:")
        return summary.strip()[:1500], [t.strip() for t in topic_line.split(",") if t.strip()][:3]
    except Exception:  # noqa: BLE001 - never lose the end-of-call save over a summary failure
        logger.exception("summary failed")
        return fallback_summary(teacher, lines, []), []


def receiving_video(room: rtc.Room) -> bool:
    """Camera honesty: is any live video actually arriving (game camera or FaceTime caller capture)?"""
    return any(
        pub.kind == rtc.TrackKind.KIND_VIDEO and pub.subscribed and not pub.muted
        for p in room.remote_participants.values() for pub in p.track_publications.values()
    )


def room_options() -> room_io.RoomOptions:
    # Gemini Live samples the newest video track (~1 frame/s while the student speaks, 1 per 3 s otherwise).
    return room_io.RoomOptions(video_input=True)


server = AgentServer()


async def on_request(req: JobRequest) -> None:
    await req.accept(name="EDUROAM Tutor", identity=AGENT_IDENTITY)


@server.rtc_session(agent_name=AGENT_NAME, on_request=on_request)
async def entrypoint(ctx: JobContext) -> None:
    api = backend()
    state = CallState(dispatch=parse_metadata(ctx.job.metadata))

    # In-game call: claim the pairing BEFORE anything is said. No valid pairing -> no private data.
    if state.dispatch.pairing_id:
        try:
            state.context = await api.resolve(state.dispatch.pairing_id)
            state.pairing_id = state.dispatch.pairing_id
        except BackendError as err:
            logger.warning("pairing rejected: %s", err.code)
            state.dispatch.pairing_id = None

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live"),
	    api_version="v1beta",
            voice=os.environ.get("GEMINI_VOICE", "Puck"),
            temperature=0.7,
        ),
    )
    tutor = Tutor(state, api)

    async def camera_changed() -> None:
        on = receiving_video(ctx.room)
        if on != state.camera_on:
            state.camera_on = on
            await tutor.refresh_instructions()

    pending: set[asyncio.Task] = set()

    def schedule_camera_check(*_args) -> None:
        task = asyncio.create_task(camera_changed())
        pending.add(task)
        task.add_done_callback(pending.discard)

    for event in ("track_subscribed", "track_unsubscribed", "track_muted", "track_unmuted"):
        ctx.room.on(event, schedule_camera_check)

    async def on_shutdown() -> None:
        if state.paired and not state.summary_saved:
            summary, topics = await summarize(session, state.teacher)
            if summary:
                try:
                    await api.end(state.pairing_id, summary, topics)  # idempotent server-side
                except BackendError as err:
                    logger.warning("end-of-call save failed: %s", err.code)
        if state.dispatch.call_id:
            try:
                await api.call_ended(state.dispatch.call_id)
            except BackendError:
                pass

    ctx.add_shutdown_callback(on_shutdown)

    await session.start(
        agent=tutor,
        room=ctx.room,
        room_options=room_options(),
    )
    await camera_changed()

    if state.paired:
        await session.generate_reply(instructions=f"Greet the student as {state.teacher} in one short, warm sentence and ask what they want to work on.")
    elif state.dispatch.facetime:
        await session.generate_reply(instructions="Greet the caller and ask for their 6-digit EDUROAM FaceTime code.")
    else:
        await session.generate_reply(instructions=(
            "Say kindly that this call link has expired, and that they should close the call and press FaceTime Tutor again in EDUROAM."))


if __name__ == "__main__":
    from livekit.agents import cli

    cli.run_app(server)
