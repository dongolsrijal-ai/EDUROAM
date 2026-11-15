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

    @property
    def facetime(self) -> bool:
        return self.call_id is not None


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
        call = data.get("facetime_call")
        if isinstance(call, str) and UUID.match(call):
            return Dispatch(call_id=call.lower())
        pairing = data.get("pairing_id")
        if isinstance(pairing, str) and UUID.match(pairing):
            return Dispatch(pairing_id=pairing.lower())
    return Dispatch()


class BackendError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


class Backend:
    """Client for POST /functions/v1/voice-agent (Authorization: Bearer VOICE_AGENT_SECRET)."""

    def __init__(self, url: str, secret: str, apikey: str | None = None, timeout: float = 15.0):
        if not url or not secret:
            raise ValueError("EDUROAM_VOICE_AGENT_URL and VOICE_AGENT_SECRET must be set")
        self.url = url
        self._secret = secret
        self._apikey = apikey
        self._timeout = timeout

    def _post(self, body: dict) -> dict:
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self._secret}"}
        if self._apikey:
            headers["apikey"] = self._apikey
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            try:
                error = json.loads(err.read() or b"{}").get("error", {})
            except ValueError:
                error = {}
            raise BackendError(err.code, error.get("code", "http_error"), error.get("message", f"HTTP {err.code}")) from None

    async def call(self, body: dict) -> dict:
        return await asyncio.to_thread(self._post, body)

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

    async def call_ended(self, call_id: str) -> dict:
        return await self.call({"action": "call_ended", "call_id": call_id})


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


def paired_instructions(state: CallState) -> str:
    """The teacher persona from the backend (same rules as text chat) plus voice/camera specifics."""
    base = (state.context or {}).get("instructions") or LOCKED_INSTRUCTIONS
    tools = ("TOOLS: get_npc_context (who you are and what you know about this student), search_coursework (their uploaded "
             "material; say which document you used), get_learning_progress, save_session_summary (call once near the end).")
    return f"{base}\n\n{tools}\n{camera_line(state.camera_on)}"


def locked_instructions(state: CallState) -> str:
    return f"{LOCKED_INSTRUCTIONS}\n{camera_line(state.camera_on)}"


def context_digest(context: dict) -> dict:
    """What get_npc_context returns to the model: no ids, just what a teacher would know."""
    npc = context.get("npc", {})
    return {
        "teacher": npc.get("name"), "subject": npc.get("subject"), "class": npc.get("class_name"),
        "teaching_preferences": context.get("teaching_preferences", []),
        "memory": context.get("memory", {}),
        "coursework_titles": [d.get("title") for d in context.get("coursework", {}).get("documents", [])],
    }


def fallback_summary(teacher: str, user_lines: list[str], topics: list[str]) -> str:
    """Used only if the model never called save_session_summary and summarising failed: topics, not raw speech."""
    if topics:
        return f"Voice call with {teacher}: worked on {', '.join(topics[:3])}."
    if user_lines:
        return f"Voice call with {teacher}: a short tutoring conversation."
    return ""
