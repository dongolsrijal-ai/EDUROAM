"""Agent-level tests for agent.py: the Tutor's tools with a fake voice-agent backend (no network, no model).

The fake backend answers like voice-agent does: every tool call carries ONLY this call's pairing id and the
server-side session decides whose data that is. Needs the LiveKit Agents SDK (pip install -r requirements.txt);
skipped without it.
    python -m unittest -v
"""

import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

try:
    from livekit import rtc

    import agent
except ImportError:  # SDK not installed: only the stdlib tests in test_eduroam_backend.py run
    agent = None

from eduroam_backend import BackendError, CallState, parse_metadata

PAIRING_A = "50000000-0000-4000-8000-00000000000a"
PAIRING_B = "50000000-0000-4000-8000-00000000000b"
HERE = os.path.dirname(os.path.abspath(__file__))


def resolved(name: str, subject: str, class_name: str, personality: str, memory: str, upcoming: list[str]) -> dict:
    """The shape voice-agent "resolve" returns (instructions come from buildVoiceInstructions server-side)."""
    return {
        "npc": {"name": name, "subject": subject, "class_name": class_name},
        "timezone": "America/New_York",
        "teaching_preferences": ["use worked examples"],
        "memory": {"summary": memory, "current_topic": "", "topics_studied": []},
        "progress": {"topics_mastered": [], "topics_needing_practice": []},
        "coursework": {"documents": [{"title": f"{subject} homework.pdf", "status": "ready", "mine": True}], "excerpts": []},
        "upcoming": upcoming,
        "instructions": f"You are {name}, a warm, patient {subject} tutor. Class: {class_name}. Your personality: {personality}",
    }


class FakeBackend:
    """voice-agent stand-in: per-session data, records every call, enforces the same rules the server does."""

    def __init__(self, sessions: dict[str, dict]):
        self.sessions = sessions
        self.expired: set[str] = set()
        self.calls: list[tuple] = []
        self.memory: dict[str, list[dict]] = {}

    def _session(self, pairing_id: str) -> dict:
        if pairing_id in self.expired or pairing_id not in self.sessions:
            raise BackendError(404, "session_inactive", "This voice session is not active.")
        return self.sessions[pairing_id]

    async def resolve(self, pairing_id):
        self.calls.append(("resolve", pairing_id))
        return self._session(pairing_id)

    async def end(self, pairing_id, summary, topics):
        self.calls.append(("end", pairing_id, summary, topics))
        self._session(pairing_id)
        return {"saved": True}

    async def pair(self, call_id, code):
        self.calls.append(("pair", call_id, code))
        return {"paired": False, "attempts_left": 4}

    async def tool(self, action, pairing_id, timeout=None, **fields):
        self.calls.append((action, pairing_id, fields))
        ctx = self._session(pairing_id)
        if action == "search":
            return {"results": [{"title": ctx["coursework"]["documents"][0]["title"], "text": f"Excerpt about {fields['query']}"}], "note": "name the document"}
        if action == "memory_save":
            self.memory.setdefault(pairing_id, []).append(fields)
            return {"saved": True, "remembered": {"summary": fields.get("summary", ""), "preference_added": bool(fields.get("preference") and fields.get("preference_confirmed"))}}
        if action == "memory_search":
            return {"memory": ctx["memory"], "saved_this_call": self.memory.get(pairing_id, [])}
        if action == "assignments":
            return {"assignments": [{"title": u} for u in ctx["upcoming"]], "found_in_documents": []}
        if action == "assignment_save":
            if fields.get("due") and not fields.get("student_confirmed_due"):
                return {"saved": True, "assignment": {"title": fields.get("title"), "due": f"{fields['due']} (suggested date, not confirmed by the student)"}}
            return {"saved": True, "assignment": {"title": fields.get("title"), "due": fields.get("due")}}
        if action == "tasks" and fields.get("op") == "create" and not fields.get("student_approved"):
            raise BackendError(400, "needs_approval", "Ask the student first, then call again with student_approved=true.")
        if action == "web":
            return {"answer": "x" * 10_000, "sources": [{"title": f"s{i}", "url": f"https://example.org/{i}"} for i in range(30)], "note": "public"}
        return {"ok": True, "action": action}


async def tutor_for(pairing_id: str, api: FakeBackend, room=None) -> "agent.Tutor":
    """What entrypoint does before the session starts: claim the pairing, then build the teacher."""
    state = CallState(dispatch=parse_metadata(pairing_id))
    try:
        state.context = await api.resolve(state.dispatch.pairing_id)
        state.pairing_id = state.dispatch.pairing_id
    except BackendError:
        state.dispatch.pairing_id = None
    return agent.Tutor(state, api, room)


def run(coro):
    return asyncio.run(coro)


def video_room(*publications):
    return SimpleNamespace(remote_participants={"student": SimpleNamespace(track_publications={str(i): p for i, p in enumerate(publications)})})


def pub(kind, subscribed=True, muted=False):
    return SimpleNamespace(kind=kind, subscribed=subscribed, muted=muted)


@unittest.skipIf(agent is None, "livekit-agents not installed")
class TutorTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeBackend({
            PAIRING_A: resolved("Professor Newton", "Physics", "Year 11 Physics", "dry wit, loves thought experiments", "Studied Newton's second law.", ["Forces lab: due tomorrow at 11:59 PM"]),
            PAIRING_B: resolved("Madame Curie", "Chemistry", "Chem 101", "calm and precise", "", []),
        })

    def test_registered_tools(self):
        names = {t.id for t in run(tutor_for(PAIRING_A, self.api)).tools}
        for name in ("search_coursework", "search_learning_memory", "save_learning_memory", "get_assignments", "save_assignment",
                     "manage_study_tasks", "create_study_plan", "search_public_web", "analyze_camera", "get_student_progress", "save_session_summary"):
            self.assertIn(name, names)
        # Not offered until they work end to end (Phase 6): no promise the tutor cannot keep.
        self.assertNotIn("get_calendar_events", names)
        self.assertNotIn("request_study_reminder", names)

    def test_first_call_speaks_as_the_selected_npc_and_knows_upcoming_work(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        self.assertTrue(tutor.state.paired)
        self.assertIn("You are Professor Newton", tutor.instructions)
        self.assertIn("dry wit", tutor.instructions)
        digest = run(tutor.get_npc_context(None))
        self.assertEqual((digest["teacher"], digest["subject"], digest["class"]), ("Professor Newton", "Physics", "Year 11 Physics"))
        self.assertEqual(digest["upcoming_work"], ["Forces lab: due tomorrow at 11:59 PM"])
        self.assertEqual(digest["timezone"], "America/New_York")

    def test_next_call_with_another_npc_loads_only_that_npc(self):
        newton = run(tutor_for(PAIRING_A, self.api))
        curie = run(tutor_for(PAIRING_B, self.api))
        self.assertIn("You are Madame Curie", curie.instructions)
        self.assertNotIn("Newton", curie.instructions)
        self.assertNotIn("Curie", newton.instructions)
        self.assertEqual(run(curie.get_npc_context(None))["upcoming_work"], [])

    def test_every_tool_uses_only_this_calls_pairing(self):
        tutor = run(tutor_for(PAIRING_B, self.api))
        run(tutor.search_coursework(None, "balancing equations"))
        run(tutor.search_learning_memory(None, "atoms"))
        run(tutor.get_student_progress(None))
        run(tutor.get_assignments(None))
        run(tutor.create_study_plan(None))
        tool_calls = [c for c in self.api.calls if c[0] != "resolve"]
        self.assertEqual({c[1] for c in tool_calls}, {PAIRING_B})
        self.assertEqual([c[0] for c in tool_calls], ["search", "memory_search", "progress", "assignments", "study_plan"])

    def test_coursework_follow_up_searches_again(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        first = run(tutor.search_coursework(None, "question 2"))
        second = run(tutor.search_coursework(None, "question 3 units"))
        self.assertEqual(first["results"][0]["title"], "Physics homework.pdf")
        self.assertEqual([c[2]["query"] for c in self.api.calls if c[0] == "search"], ["question 2", "question 3 units"])
        self.assertIn("question 3", second["results"][0]["text"])

    def test_memory_saved_mid_call_is_recalled_and_preferences_need_consent(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        run(tutor.save_learning_memory(None, summary="Fixed the mass vs weight mix-up.", topics=["forces"], mastered=["mass vs weight"],
                                       preference="short explanations", preference_confirmed=False))
        saved = self.api.memory[PAIRING_A][0]
        self.assertFalse(saved["preference_confirmed"])
        self.assertEqual(saved["mastered"], ["mass vs weight"])
        recalled = run(tutor.search_learning_memory(None, "forces"))
        self.assertEqual(recalled["saved_this_call"][0]["summary"], "Fixed the mass vs weight mix-up.")
        run(tutor.save_learning_memory(None, preference="short explanations", preference_confirmed=True))
        self.assertTrue(self.api.memory[PAIRING_A][1]["preference_confirmed"])
        self.assertNotIn(PAIRING_B, self.api.memory, "nothing written for another session")

    def test_untrusted_arguments_are_cleaned_before_they_leave_the_agent(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        run(tutor.save_learning_memory(None, summary="ok\x00\x07  fine", topics=["a", 5, "", "b" * 500], preference_confirmed="yes"))
        sent = self.api.memory[PAIRING_A][0]
        self.assertEqual(sent["summary"], "ok fine")
        self.assertEqual(sent["topics"], ["a", "b" * 120])
        self.assertIs(sent["preference_confirmed"], False, "only a real True counts as consent")

    def test_tutor_due_dates_are_suggestions_and_tasks_need_approval(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        saved = run(tutor.save_assignment(None, title="Unit test", due="2026-11-24 09:00"))
        self.assertIn("suggested date", saved["assignment"]["due"])
        refused = run(tutor.manage_study_tasks(None, op="create", title="Review", starts="2026-11-18 18:00"))
        self.assertEqual(refused["error"], "needs_approval")

    def test_large_results_are_capped_for_voice(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        out = run(tutor.search_public_web(None, "AP exam date"))
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(__import__("json").dumps(out)), 3600)
        self.assertEqual([c for c in self.api.calls if c[0] == "web"][0][2]["query"], "AP exam date")

    def test_rejected_or_expired_pairing_gets_no_private_data(self):
        tutor = run(tutor_for("50000000-0000-4000-8000-0000000000ff", self.api))  # unknown / already used
        self.assertFalse(tutor.state.paired)
        before = len(self.api.calls)
        self.assertTrue(run(tutor.get_npc_context(None))["locked"])
        self.assertTrue(run(tutor.search_coursework(None, "anything"))["locked"])
        self.assertTrue(run(tutor.get_assignments(None))["locked"])
        self.assertTrue(run(tutor.save_learning_memory(None, summary="x"))["locked"])
        self.assertIn("never paired", run(tutor.save_session_summary(None, "x", [])))
        self.assertEqual(len(self.api.calls), before, "a locked call never reaches the backend")

    def test_session_that_expires_mid_call_fails_safely(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        self.api.expired.add(PAIRING_A)
        result = run(tutor.search_coursework(None, "forces"))
        self.assertEqual(result["error"], "session_inactive")
        self.assertNotIn("results", result)

    def test_camera_tool_reports_only_real_video(self):
        self.assertIs(agent.room_options().video_input, True, "frames are sent to Gemini Live")
        audio, video = rtc.TrackKind.KIND_AUDIO, rtc.TrackKind.KIND_VIDEO
        no_video = run(tutor_for(PAIRING_A, self.api, video_room(pub(audio)))).analyze_camera(None)
        self.assertFalse(run(no_video)["video"])
        muted = run(run(tutor_for(PAIRING_A, self.api, video_room(pub(audio), pub(video, muted=True)))).analyze_camera(None))
        self.assertFalse(muted["video"])
        self.assertIn("cannot see", muted["guidance"])
        live = run(run(tutor_for(PAIRING_A, self.api, video_room(pub(audio), pub(video)))).analyze_camera(None))
        self.assertTrue(live["video"])
        self.assertIn("live video", live["guidance"])
        tutor = run(tutor_for(PAIRING_A, self.api, video_room(pub(video))))
        before = tutor.instructions
        run(tutor.analyze_camera(None))
        self.assertEqual(tutor.instructions, before, "no instruction rewrite on camera changes")

    def test_dispatch_name_can_be_overridden_for_self_hosting(self):
        def registered_name(env: dict) -> str:
            code = "import warnings; warnings.simplefilter('ignore'); import agent; print(agent.server._agent_name)"
            base = {k: v for k, v in os.environ.items() if k != "LIVEKIT_AGENT_NAME_OVERRIDE"}
            with tempfile.TemporaryDirectory() as cwd:  # away from agent/.env.local
                out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, cwd=cwd,
                                     env={**base, "PYTHONPATH": HERE, **env})
            return out.stdout.strip().splitlines()[-1]

        self.assertEqual(registered_name({}), "eduroam-tutor")
        self.assertEqual(registered_name({"LIVEKIT_AGENT_NAME_OVERRIDE": "eduroam-tutor-code"}), "eduroam-tutor-code")
        self.assertEqual(agent.AGENT_IDENTITY, "eduroam-tutor")


if __name__ == "__main__":
    unittest.main()
