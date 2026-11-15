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
    Backend, BackendError, CallState, bridge_ready, camera_line, cap_output, chert_call_id, clean_list, clean_text, context_digest,
    fallback_summary, locked_instructions, paired_instructions, parse_metadata,
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
    """One teacher for one call. Every tool goes through voice-agent with this call's pairing id only:
    the server decides which student, NPC and class that is, so a tool can never reach anyone else's data."""

    def __init__(self, state: CallState, api: Backend, room: rtc.Room | None = None) -> None:
        self.state = state
        self.api = api
        self.room = room
        super().__init__(instructions=paired_instructions(state) if state.paired else locked_instructions(state))

    async def refresh_instructions(self) -> None:
        # Only on FaceTime pairing (locked -> teacher). Never per camera change: see paired_instructions.
        await self.update_instructions(paired_instructions(self.state) if self.state.paired else locked_instructions(self.state))

    async def _tool(self, action: str, timeout: float | None = None, **fields) -> dict:
        """One scoped backend call: locked calls get nothing; errors come back as something sayable."""
        if not self.state.paired:
            return {"locked": True, "message": "No EDUROAM code yet. Ask for the 6-digit code first."}
        try:
            return cap_output(await self.api.tool(action, self.state.pairing_id, timeout=timeout, **fields))
        except BackendError as err:
            logger.warning("tool %s failed: %s", action, err.code)
            return {"error": err.code, "message": str(err)}

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
        """Who you are (teacher name, subject, class), how this student likes to be taught, what you remember, and upcoming work."""
        if not self.state.paired:
            return {"locked": True, "message": "No EDUROAM code yet. Ask for the 6-digit code first."}
        return context_digest(self.state.context or {})

    @function_tool()
    async def search_coursework(self, context: RunContext, query: str) -> dict:
        """Search this student's uploaded coursework for this class (notes, worksheets, PDFs, DOCX, textbook pages).

        Args:
            query: what to look for, e.g. "power rule examples" or "worksheet question 3".
        """
        return await self._tool("search", query=clean_text(query, 300))

    @function_tool()
    async def search_learning_memory(self, context: RunContext, query: str = "") -> dict:
        """Recall earlier lessons with this student: summary, topics, learning preferences and matching lines from earlier text chats.

        Args:
            query: optional topic to look for, e.g. "fractions"; empty for the overview.
        """
        return await self._tool("memory_search", query=clean_text(query, 300))

    @function_tool()
    async def save_learning_memory(self, context: RunContext, summary: str = "", topics: list[str] | None = None,
                                   mastered: list[str] | None = None, needs_practice: list[str] | None = None,
                                   preference: str = "", preference_confirmed: bool = False) -> dict:
        """Remember something meaningful from this conversation (no transcripts, no personal details).

        Args:
            summary: one or two sentences, e.g. "Fixed the mix-up between mass and weight; solved two problems alone."
            topics: topics worked on, e.g. ["forces"].
            mastered: topics the student now clearly understands.
            needs_practice: topics or misconceptions still to work on.
            preference: how they like to learn, e.g. "short explanations with an example".
            preference_confirmed: true only if the student said yes to remembering that preference just now.
        """
        return await self._tool("memory_save", summary=clean_text(summary, 1500), topics=clean_list(topics), mastered=clean_list(mastered),
                                needs_practice=clean_list(needs_practice), preference=clean_text(preference, 120),
                                preference_confirmed=preference_confirmed is True)

    @function_tool()
    async def get_student_progress(self, context: RunContext) -> dict:
        """This student's progress with you: mastered and weak topics, last topic, recent quiz results."""
        return await self._tool("progress")

    @function_tool()
    async def get_assignments(self, context: RunContext) -> dict:
        """The student's assignments for this class (due dates in their own timezone, status), plus deadlines found in their files to confirm."""
        return await self._tool("assignments")

    @function_tool()
    async def save_assignment(self, context: RunContext, title: str = "", assignment_id: str = "", description: str = "",
                              due: str = "", student_confirmed_due: bool = False, status: str = "",
                              estimated_minutes: int | None = None) -> dict:
        """Add an assignment or update one from get_assignments.

        Args:
            title: name of new work, e.g. "Lab report 3" (ignored when updating).
            assignment_id: the id from get_assignments to update; empty to add new work.
            description: short description for new work.
            due: local due time "YYYY-MM-DD HH:MM" (24 h) or "YYYY-MM-DD" (end of day). Only a date the student or a document stated.
            student_confirmed_due: true only if the student just confirmed exactly this due date.
            status: "todo", "in_progress" or "done", as the student says.
            estimated_minutes: how long the student expects it to take.
        """
        return await self._tool("assignment_save", assignment_id=assignment_id or None, title=clean_text(title, 160) or None,
                                description=clean_text(description, 2000) or None, due=due.strip() or None,
                                student_confirmed_due=student_confirmed_due is True, status=status or None, estimated_minutes=estimated_minutes)

    @function_tool()
    async def create_study_plan(self, context: RunContext, daily_minutes: int = 60, start_hour: int = 17, days: int = 7) -> dict:
        """Propose study sessions from deadlines, estimates and weak topics. Nothing is saved.

        Args:
            daily_minutes: study minutes per day the student wants (15-240).
            start_hour: local hour they usually start (6-22).
            days: how many days ahead to plan (1-21).
        """
        return await self._tool("study_plan", daily_minutes=daily_minutes, start_hour=start_hour, days=days)

    @function_tool()
    async def manage_study_tasks(self, context: RunContext, op: str = "list", task_id: str = "", assignment_id: str = "", title: str = "",
                                 starts: str = "", minutes: int | None = None, status: str = "", student_approved: bool = False) -> dict:
        """List, add or update the student's study sessions for this class.

        Args:
            op: "list", "create" or "update".
            task_id: the id from a previous list, for update.
            assignment_id: optional assignment this session is for.
            title: e.g. "Review chapter 4".
            starts: local start "YYYY-MM-DD HH:MM" (24 h).
            minutes: length, 5-600.
            status: "planned", "done", "skipped" or "cancelled".
            student_approved: true only if the student just agreed to adding or moving this session.
        """
        return await self._tool("tasks", op=op, task_id=task_id or None, assignment_id=assignment_id or None, title=clean_text(title, 160) or None,
                                starts=starts.strip() or None, minutes=minutes, status=status or None, student_approved=student_approved is True)

    @function_tool()
    async def search_public_web(self, context: RunContext, query: str) -> dict:
        """Current PUBLIC information from the web with source links (never the student's private data).

        Args:
            query: a general question, e.g. "When is the 2027 AP Biology exam?"
        """
        return await self._tool("web", timeout=15.0, query=clean_text(query, 300))

    @function_tool()
    async def analyze_camera(self, context: RunContext) -> dict:
        """Check whether live video from the student is arriving before you describe what you see."""
        on = receiving_video(self.room) if self.room is not None else False
        self.state.camera_on = on
        return {"video": on, "guidance": camera_line(on)}

    @function_tool()
    async def save_session_summary(self, context: RunContext, summary: str, topics: list[str]) -> str:
        """Save what was studied on this call to the student's memory with you (call once, near the end).

        Args:
            summary: one or two sentences, e.g. "Practised the power rule; struggled with negative exponents, then got two right."
            topics: short topic names, e.g. ["power rule", "derivatives"].
        """
        if not self.state.paired:
            return "Nothing to save: this call was never paired."
        self.state.topics = clean_list(topics)
        try:
            result = await self.api.end(self.state.pairing_id, clean_text(summary, 1500), self.state.topics)
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


def room_options(participant_identity: str | None = None) -> room_io.RoomOptions:
    # Gemini Live samples the newest video track (~1 frame/s while the student speaks, 1 per 3 s otherwise).
    # On FaceTime (chert dev) audio and camera come only from the caller's bridge participant.
    if participant_identity:
        return room_io.RoomOptions(video_input=True, participant_identity=participant_identity)
    return room_io.RoomOptions(video_input=True)


async def wait_for_chert_caller(ctx: JobContext) -> rtc.RemoteParticipant | None:
    """chert dev keeps a warm room with this agent in it before any call. Join it, open no paid model
    session, and wait for the FaceTime caller (chert-bridge-<call id>). Anyone else is ignored."""
    await ctx.connect()
    while True:
        participant = await ctx.wait_for_participant()
        if chert_call_id(participant.identity):
            return participant
        logger.warning("ignoring non-Chert participant in a Chert room")
        await asyncio.sleep(0.5)


def env_number(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# Always-on hosting (Linux container, see agent/DEPLOY.md). Cost / stability limits, all overridable:
#   MAX_CALL_MINUTES      hard cap on one call (the tutor says goodbye, then the job ends)  default 45
#   AGENT_IDLE_PROCESSES  warm job processes kept ready                                      default 1
#   JOB_MEMORY_LIMIT_MB   a job using more is restarted instead of taking the worker down    default 1500
MAX_CALL_SECONDS = max(60.0, env_number("MAX_CALL_MINUTES", 45) * 60)

server = AgentServer(
    num_idle_processes=int(env_number("AGENT_IDLE_PROCESSES", 1)),
    job_memory_warn_mb=1000,
    job_memory_limit_mb=env_number("JOB_MEMORY_LIMIT_MB", 1500),
    # Import the Gemini plugin at process start, not on the first call (avoids a stalled first turn).
    preload_modules=["livekit.plugins.google"],
    # A redeploy / SIGTERM lets active calls finish (up to 30 min) before the worker exits.
    drain_timeout=1800,
)


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
    tutor = Tutor(state, api, ctx.room)

    # Camera state is read on demand by analyze_camera (no instruction rewrites mid-call).

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

    caller_identity = None
    if state.dispatch.chert:
        caller = await wait_for_chert_caller(ctx)
        caller_identity = caller.identity
        try:
            # Record the FaceTime call so the caller can pair with the 6-digit code from EDUROAM.
            opened = await api.facetime_open(chert_call_id(caller.identity))
            state.dispatch.call_id = opened["call_id"]
        except BackendError as err:
            logger.warning("facetime call not registered: %s", err.code)
        logger.info("FaceTime caller joined", extra={"room": ctx.room.name})

    await session.start(
        agent=tutor,
        room=ctx.room,
        room_options=room_options(caller_identity),
    )

    async def end_long_call() -> None:
        await asyncio.sleep(MAX_CALL_SECONDS)
        logger.info("call reached MAX_CALL_MINUTES; ending", extra={"room": ctx.room.name})
        try:
            await session.generate_reply(instructions="Our time is up for this call. Say a short, warm goodbye and suggest calling again later.")
            await asyncio.sleep(8)
        finally:
            ctx.shutdown(reason="max call length")

    limit = asyncio.create_task(end_long_call(), name="max-call-length")

    async def cancel_limit() -> None:
        limit.cancel()

    ctx.add_shutdown_callback(cancel_limit)

    if state.dispatch.chert:
        # Greet once, on chert dev's bridge_ready room signal (the Mac ends a call silent for 10 s after it).
        greeted = asyncio.Event()
        greeting: list = []

        def greet_if_ready(*_args) -> None:
            if greeted.is_set() or not bridge_ready(ctx.room.metadata):
                return
            greeted.set()
            text = ("Greet the caller warmly in one short sentence as their EDUROAM tutor and ask for the 6-digit FaceTime code "
                    "shown in EDUROAM." if state.dispatch.call_id else
                    "Say kindly that the EDUROAM line cannot take calls right now and ask them to try again in a minute.")
            greeting.append(session.generate_reply(instructions=text))  # returns a SpeechHandle (not a coroutine)

        ctx.room.on("room_metadata_changed", greet_if_ready)
        greet_if_ready()
    elif state.paired:
        await session.generate_reply(instructions=f"Greet the student as {state.teacher} in one short, warm sentence and ask what they want to work on.")
    elif state.dispatch.facetime:
        await session.generate_reply(instructions="Greet the caller and ask for their 6-digit EDUROAM FaceTime code.")
    else:
        await session.generate_reply(instructions=(
            "Say kindly that this call link has expired, and that they should close the call and press FaceTime Tutor again in EDUROAM."))


if __name__ == "__main__":
    from livekit.agents import cli

    cli.run_app(server)
