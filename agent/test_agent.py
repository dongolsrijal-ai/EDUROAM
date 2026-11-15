"""Agent-level tests for agent.py: the Tutor's tools with a fake voice-agent backend (no network, no model).

Needs the LiveKit Agents SDK (pip install -r requirements.txt); skipped without it.
    python -m unittest -v
"""

import asyncio
import unittest
from types import SimpleNamespace

try:
    from livekit import rtc

    import agent
except ImportError:  # SDK not installed: only the stdlib tests in test_eduroam_backend.py run
    agent = None

from eduroam_backend import BackendError, CallState, Dispatch, parse_metadata

PAIRING_A = "50000000-0000-4000-8000-00000000000a"
PAIRING_B = "50000000-0000-4000-8000-00000000000b"


def resolved(name: str, subject: str, class_name: str, personality: str, memory: str) -> dict:
    """The shape voice-agent "resolve" returns (instructions come from buildVoiceInstructions server-side)."""
    return {
        "npc": {"name": name, "subject": subject, "class_name": class_name},
        "teaching_preferences": ["use worked examples"],
        "memory": {"summary": memory, "current_topic": "", "topics_studied": []},
        "progress": {"topics_mastered": [], "topics_needing_practice": []},
        "coursework": {"documents": [{"title": f"{subject} homework.pdf", "status": "ready", "mine": True}], "excerpts": []},
        "instructions": f"You are {name}, a warm, patient {subject} tutor. Class: {class_name}. Your personality: {personality}",
    }


class FakeBackend:
    """Records every call; answers like voice-agent does for the pairing it was given."""

    def __init__(self, sessions: dict[str, dict], expired: set[str] = frozenset()):
        self.sessions = sessions
        self.expired = set(expired)
        self.calls: list[tuple] = []

    def _check(self, pairing_id: str) -> dict:
        if pairing_id in self.expired or pairing_id not in self.sessions:
            raise BackendError(404, "session_inactive", "This voice session is not active.")
        return self.sessions[pairing_id]

    async def resolve(self, pairing_id):
        self.calls.append(("resolve", pairing_id))
        return self._check(pairing_id)

    async def search(self, pairing_id, query):
        self.calls.append(("search", pairing_id, query))
        ctx = self._check(pairing_id)
        title = ctx["coursework"]["documents"][0]["title"]
        return {"results": [{"title": title, "text": f"Excerpt about {query}", "page": 1, "mine": True}], "not_ready": [], "note": "name the document"}

    async def progress(self, pairing_id):
        self.calls.append(("progress", pairing_id))
        return {"memory": self._check(pairing_id)["memory"], "progress": {"topics_mastered": ["vectors"], "topics_needing_practice": []}}

    async def end(self, pairing_id, summary, topics):
        self.calls.append(("end", pairing_id, summary, topics))
        self._check(pairing_id)
        return {"saved": True}

    async def pair(self, call_id, code):
        self.calls.append(("pair", call_id, code))
        return {"paired": False, "attempts_left": 4}


async def tutor_for(pairing_id: str, api: FakeBackend) -> "agent.Tutor":
    """What entrypoint does before the session starts: claim the pairing, then build the teacher."""
    state = CallState(dispatch=parse_metadata(pairing_id))
    try:
        state.context = await api.resolve(state.dispatch.pairing_id)
        state.pairing_id = state.dispatch.pairing_id
    except BackendError:
        state.dispatch.pairing_id = None
    return agent.Tutor(state, api)


def run(coro):
    return asyncio.run(coro)


@unittest.skipIf(agent is None, "livekit-agents not installed")
class TutorTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeBackend({
            PAIRING_A: resolved("Professor Newton", "Physics", "Year 11 Physics", "dry wit, loves thought experiments", "Studied Newton's second law."),
            PAIRING_B: resolved("Madame Curie", "Chemistry", "Chem 101", "calm and precise", ""),
        })

    def test_first_call_speaks_as_the_selected_npc(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        self.assertTrue(tutor.state.paired)
        self.assertEqual(tutor.state.teacher, "Professor Newton")
        self.assertIn("You are Professor Newton", tutor.instructions)
        self.assertIn("dry wit", tutor.instructions)
        self.assertIn("search_coursework", tutor.instructions)
        self.assertNotIn("shared EDUROAM tutoring line", tutor.instructions)
        digest = run(tutor.get_npc_context(None))
        self.assertEqual((digest["teacher"], digest["subject"], digest["class"]), ("Professor Newton", "Physics", "Year 11 Physics"))
        self.assertEqual(digest["memory"]["summary"], "Studied Newton's second law.")

    def test_next_call_with_another_npc_loads_only_that_npc(self):
        newton = run(tutor_for(PAIRING_A, self.api))
        curie = run(tutor_for(PAIRING_B, self.api))
        self.assertIn("You are Madame Curie", curie.instructions)
        self.assertNotIn("Newton", curie.instructions)
        self.assertNotIn("Curie", newton.instructions)
        self.assertEqual(run(curie.get_npc_context(None))["coursework_titles"], ["Chemistry homework.pdf"])

    def test_search_uses_this_calls_pairing_and_returns_the_source_document(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        result = run(tutor.search_coursework(None, "homework question 2"))
        self.assertEqual(self.api.calls[-1], ("search", PAIRING_A, "homework question 2"))
        self.assertEqual(result["results"][0]["title"], "Physics homework.pdf")

    def test_progress_and_summary_are_saved_for_this_session_only(self):
        tutor = run(tutor_for(PAIRING_B, self.api))
        self.assertEqual(run(tutor.get_learning_progress(None))["progress"]["topics_mastered"], ["vectors"])
        self.assertEqual(run(tutor.save_session_summary(None, "Balanced two equations.", ["balancing equations"])), "Saved.")
        self.assertEqual(self.api.calls[-1], ("end", PAIRING_B, "Balanced two equations.", ["balancing equations"]))
        self.assertTrue(tutor.state.summary_saved)

    def test_rejected_or_expired_pairing_gets_no_private_data(self):
        tutor = run(tutor_for("50000000-0000-4000-8000-0000000000ff", self.api))  # unknown / already used
        self.assertFalse(tutor.state.paired)
        before = len(self.api.calls)
        self.assertTrue(run(tutor.get_npc_context(None))["locked"])
        self.assertTrue(run(tutor.search_coursework(None, "anything"))["locked"])
        self.assertTrue(run(tutor.get_learning_progress(None))["locked"])
        self.assertIn("never paired", run(tutor.save_session_summary(None, "x", [])))
        self.assertEqual(len(self.api.calls), before, "a locked call never reaches the backend")
        self.assertNotIn("Newton", tutor.instructions)

    def test_session_that_expires_mid_call_fails_safely(self):
        tutor = run(tutor_for(PAIRING_A, self.api))
        self.api.expired.add(PAIRING_A)
        result = run(tutor.search_coursework(None, "forces"))
        self.assertEqual(result["error"], "session_inactive")
        self.assertNotIn("results", result)
        self.assertEqual(run(tutor.get_learning_progress(None)), {"error": "session_inactive"})

    def test_camera_frames_go_to_the_model_and_instructions_track_real_video(self):
        self.assertIs(agent.room_options().video_input, True)

        def pub(kind, subscribed=True, muted=False):
            return SimpleNamespace(kind=kind, subscribed=subscribed, muted=muted)

        def room(*pubs):
            return SimpleNamespace(remote_participants={"student": SimpleNamespace(track_publications={str(i): p for i, p in enumerate(pubs)})})

        audio, video = rtc.TrackKind.KIND_AUDIO, rtc.TrackKind.KIND_VIDEO
        self.assertFalse(agent.receiving_video(room(pub(audio))))
        self.assertFalse(agent.receiving_video(room(pub(audio), pub(video, muted=True))))
        self.assertFalse(agent.receiving_video(room(pub(video, subscribed=False))))
        self.assertTrue(agent.receiving_video(room(pub(audio), pub(video))))

        tutor = run(tutor_for(PAIRING_A, self.api))
        self.assertIn("no video is being received", tutor.instructions)
        tutor.state.camera_on = True

        async def refresh():
            # update_instructions needs a running session; check what refresh would install instead.
            return agent.paired_instructions(tutor.state)

        self.assertIn("live video from the student is coming in", run(refresh()))

    def test_dispatch_name_can_be_overridden_for_self_hosting(self):
        import os
        import subprocess
        import sys

        def registered_name(env: dict) -> str:
            code = "import warnings; warnings.simplefilter('ignore'); import agent; print(agent.server._agent_name)"
            base = {k: v for k, v in os.environ.items() if k != "LIVEKIT_AGENT_NAME_OVERRIDE"}
            out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env={**base, **env}, check=True,
                                 cwd=os.path.dirname(os.path.abspath(__file__)))
            return out.stdout.strip().splitlines()[-1]

        self.assertEqual(registered_name({}), "eduroam-tutor")
        self.assertEqual(registered_name({"LIVEKIT_AGENT_NAME_OVERRIDE": "eduroam-tutor-code"}), "eduroam-tutor-code")
        # The participant identity stays fixed whatever the dispatch name is (Chert's bridge names it).
        self.assertEqual(agent.AGENT_IDENTITY, "eduroam-tutor")


if __name__ == "__main__":
    unittest.main()
