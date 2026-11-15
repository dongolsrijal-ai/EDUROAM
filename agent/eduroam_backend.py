"""EDUROAM backend pieces for the "eduroam-tutor" LiveKit agent (stdlib only, unit-tested).

The agent never sees a player id, NPC id or phone number. It knows only what the dispatch
metadata carries:

* an in-game call:  the opaque pairing id (a UUID string) created by voice-session;
* a FaceTime call:  {"facetime_call": "<uuid>"} created by chert-webhook. The call starts LOCKED
  until the caller says the 6-digit code shown to them in EDUROAM (voice-agent "pair").

Every private read goes through the protected voice-agent Edge Function with VOICE_AGENT_SECRET.
"""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field

UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@dataclass
class Dispatch:
    """What this job is: an in-game call (pairing_id) or a FaceTime call (call_id), or neither."""

    pairing_id: str | None = None
    call_id: str | None = None
    # A room prepared by `chert dev` (shared FaceTime line): the caller joins later as chert-bridge-<id>.
    chert: bool = False

    @property
    def facetime(self) -> bool:
        return self.call_id is not None or self.chert


def parse_metadata(metadata: str | None) -> Dispatch:
    """Dispatch metadata -> Dispatch. Anything unexpected is treated as an unpaired (locked) call."""
    text = (metadata or "").strip()
    if UUID.match(text):
        return Dispatch(pairing_id=text.lower())
    try:
        data = json.loads(text) if text else None
    except ValueError:
        data = None
    if isinstance(data, dict):
        # chert dev: {"chert_warm": true} before any call, {"chert_call": "<id>", "media": ...} for a call.
        if data.get("chert_warm") is True or isinstance(data.get("chert_call"), str):
            return Dispatch(chert=True)
        call = data.get("facetime_call")
        if isinstance(call, str) and UUID.match(call):
            return Dispatch(call_id=call.lower())
        pairing = data.get("pairing_id")
        if isinstance(pairing, str) and UUID.match(pairing):
            return Dispatch(pairing_id=pairing.lower())
    return Dispatch()


CHERT_BRIDGE_PREFIX = "chert-bridge-"
_CHERT_CALL = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def chert_call_id(identity: str | None) -> str | None:
    """The Chert call id of the FaceTime caller's participant (chert-bridge-<call id>), else None."""
    if not identity or not identity.startswith(CHERT_BRIDGE_PREFIX):
        return None
    call = identity[len(CHERT_BRIDGE_PREFIX):]
    return call if _CHERT_CALL.match(call) else None


def bridge_ready(metadata: str | None) -> bool:
    """chert dev's room signal that FaceTime audio is connected: greet within 10 s of it, never before."""
    try:
        return json.loads(metadata or "{}").get("chert_bridge_ready") is True
    except (ValueError, AttributeError):
        return False


class BackendError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


class Backend:
    """Client for POST /functions/v1/voice-agent (Authorization: Bearer VOICE_AGENT_SECRET)."""

    def __init__(self, url: str, secret: str, apikey: str | None = None, timeout: float = 8.0):
        if not url or not secret:
            raise ValueError("EDUROAM_VOICE_AGENT_URL and VOICE_AGENT_SECRET must be set")
        self.url = url
        self._secret = secret
        self._apikey = apikey
        self._timeout = timeout

    def _post(self, body: dict, timeout: float | None = None) -> dict:
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self._secret}"}
        if self._apikey:
            headers["apikey"] = self._apikey
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout or self._timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            try:
                error = json.loads(err.read() or b"{}").get("error", {})
            except ValueError:
                error = {}
            raise BackendError(err.code, error.get("code", "http_error"), error.get("message", f"HTTP {err.code}")) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            # Network trouble or a slow backend: a structured error the tool can say out loud.
            raise BackendError(503, "unavailable", "The EDUROAM server did not answer in time.") from None

    async def call(self, body: dict, timeout: float | None = None) -> dict:
        return await asyncio.to_thread(self._post, body, timeout)

    async def resolve(self, pairing_id: str) -> dict:
        return await self.call({"action": "resolve", "pairing_id": pairing_id})

    async def pair(self, call_id: str, code: str) -> dict:
        return await self.call({"action": "pair", "call_id": call_id, "code": code})

    async def search(self, pairing_id: str, query: str) -> dict:
        return await self.call({"action": "search", "pairing_id": pairing_id, "query": query})

    async def progress(self, pairing_id: str) -> dict:
        return await self.call({"action": "progress", "pairing_id": pairing_id})

    async def end(self, pairing_id: str, summary: str, topics: list[str]) -> dict:
        return await self.call({"action": "end", "pairing_id": pairing_id, "summary": summary, "topics": topics})

    async def facetime_open(self, chert_call: str) -> dict:
        """Registers a chert dev FaceTime call so the caller can pair with their 6-digit code."""
        return await self.call({"action": "facetime_open", "chert_call_id": chert_call})

    async def call_ended(self, call_id: str) -> dict:
        return await self.call({"action": "call_ended", "call_id": call_id})

    # The tutor's tools (voice-agent actions; the server scopes every one to this session's student).
    async def tool(self, action: str, pairing_id: str, timeout: float | None = None, **fields) -> dict:
        body = {"action": action, "pairing_id": pairing_id, **{k: v for k, v in fields.items() if v is not None}}
        return await self.call(body, timeout)


@dataclass
class CallState:
    """One job's state. `context` is set only after the server authorised this session."""

    dispatch: Dispatch
    pairing_id: str | None = None
    context: dict | None = None
    camera_on: bool = False
    summary_saved: bool = False
    topics: list[str] = field(default_factory=list)

    @property
    def paired(self) -> bool:
        return self.context is not None and self.pairing_id is not None

    @property
    def teacher(self) -> str:
        return (self.context or {}).get("npc", {}).get("name", "your EDUROAM tutor")


LOCKED_INSTRUCTIONS = """You answer the shared EDUROAM tutoring line. You do not know who is calling yet, and you must not
pretend to be any particular teacher or mention anyone's classes, notes or progress.
Greet the caller in one short friendly sentence and ask for the 6-digit FaceTime code shown in EDUROAM
(walk up to a teacher, choose FaceTime Tutor, then Call on FaceTime). When they say six digits, call the
pair_with_code tool with exactly those digits. If the code is wrong, say so kindly and ask them to read it
again. If they have no code, explain how to get one. Keep every reply short and spoken; no lists or symbols."""


def camera_line(on: bool) -> str:
    if on:
        return ("CAMERA: live video from the student is coming in. When they show work, first say briefly what you see, "
                "then help. If it is unclear, ask them to hold it closer, steadier or in better light.")
    return ("CAMERA: no video is being received right now. If the student asks you to look at something, say you cannot "
            "see it yet and ask them to turn their camera on and point it at the page. Never describe what you cannot see.")


TOOLS = """TOOLS (use them; never guess what they would return):
- search_coursework: the student's uploaded notes, worksheets and class files. Say which document you used. Search again for follow-ups.
- search_learning_memory: what you studied together before, earlier chat lines, how they like to learn.
- save_learning_memory: after something meaningful (a topic understood, a misconception fixed). Add a learning preference only if the student agreed to it just now.
- get_student_progress: mastered and weak topics, recent quiz results.
- get_assignments: their work for this class with real due dates, plus deadlines found in their files (suggestions to confirm, never facts).
- save_assignment: add work or update its status. A due date the student did not confirm is saved as a suggestion; never change a confirmed date unless they say so.
- create_study_plan: propose study sessions from deadlines and weak topics. Nothing is saved until the student agrees.
- manage_study_tasks: list, add or move study sessions, only with the student's yes.
- search_public_web: current public information with source links. Keep it separate from their coursework and say where it came from.
- analyze_camera: call before describing anything you see. If no video is arriving, say so and ask them to turn the camera on.
- save_session_summary: once, near the end of the call."""


def paired_instructions(state: CallState) -> str:
    """The teacher persona from the backend (same rules as text chat) plus the voice tools.

    Static for the whole call: Gemini Live (Gemini API) appends a mid-call instruction update to the
    conversation as a model turn, so camera state comes from analyze_camera instead.
    """
    base = (state.context or {}).get("instructions") or LOCKED_INSTRUCTIONS
    return f"{base}\n\n{TOOLS}"


def cap_output(result: dict, max_chars: int = 3500) -> dict:
    """Keep tool results short enough for a voice turn: long lists are trimmed, never cut mid-JSON."""
    text = json.dumps(result, ensure_ascii=False)
    if len(text) <= max_chars:
        return result
    trimmed = dict(result)
    for key, value in sorted(trimmed.items(), key=lambda kv: -len(json.dumps(kv[1], ensure_ascii=False))):
        if isinstance(value, list) and len(value) > 1:
            while len(value) > 1 and len(json.dumps(trimmed, ensure_ascii=False)) > max_chars:
                value = value[:-1]
                trimmed[key] = value
        elif isinstance(value, str) and len(value) > 400:
            trimmed[key] = value[:400] + "…"
        if len(json.dumps(trimmed, ensure_ascii=False)) <= max_chars:
            break
    trimmed["truncated"] = True
    return trimmed


def locked_instructions(state: CallState) -> str:
    return LOCKED_INSTRUCTIONS


_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


def clean_text(value: object, max_len: int) -> str:
    """Model-generated tool arguments are untrusted: strings only, no control characters, bounded."""
    if not isinstance(value, str):
        return ""
    return " ".join(_CONTROL.sub(" ", value).split())[:max_len]


def clean_list(values: object, max_items: int = 10, max_len: int = 120) -> list[str]:
    if not isinstance(values, list):
        return []
    return [t for t in (clean_text(v, max_len) for v in values) if t][:max_items]


def context_digest(context: dict) -> dict:
    """What get_npc_context returns to the model: no ids, just what a teacher would know."""
    npc = context.get("npc", {})
    return {
        "teacher": npc.get("name"), "subject": npc.get("subject"), "class": npc.get("class_name"),
        "teaching_preferences": context.get("teaching_preferences", []),
        "memory": context.get("memory", {}),
        "coursework_titles": [d.get("title") for d in context.get("coursework", {}).get("documents", [])],
        "upcoming_work": context.get("upcoming", []),
        "timezone": context.get("timezone"),
    }


def fallback_summary(teacher: str, user_lines: list[str], topics: list[str]) -> str:
    """Used only if the model never called save_session_summary and summarising failed: topics, not raw speech."""
    if topics:
        return f"Voice call with {teacher}: worked on {', '.join(topics[:3])}."
    if user_lines:
        return f"Voice call with {teacher}: a short tutoring conversation."
    return ""
