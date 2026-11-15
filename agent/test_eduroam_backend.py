"""Stdlib-only tests for eduroam_backend (no LiveKit install needed):  python -m unittest -v"""

import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from eduroam_backend import (
    Backend, BackendError, CallState, Dispatch, LOCKED_INSTRUCTIONS, camera_line, context_digest, fallback_summary,
    locked_instructions, paired_instructions, parse_metadata,
)

PAIRING = "50000000-0000-4000-8000-000000000001"
CALL = "60000000-0000-4000-8000-000000000001"
SECRET = "test-agent-secret"
CONTEXT = {
    "room": "eduroam-ft-x", "npc": {"name": "Professor Maple", "subject": "Mathematics", "class_name": "Maths"},
    "teaching_preferences": ["use worked examples"], "memory": {"summary": "Practised fractions."},
    "coursework": {"documents": [{"title": "Fractions worksheet", "status": "ready", "mine": True}], "excerpts": []},
    "instructions": "You are Professor Maple, a warm, patient Mathematics tutor.",
}


class FakeVoiceAgent(BaseHTTPRequestHandler):
    """A stand-in for the voice-agent Edge Function: checks the bearer secret and answers per action."""

    calls: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeVoiceAgent.calls.append((self.headers.get("Authorization"), body))
        if self.headers.get("Authorization") != f"Bearer {SECRET}":
            return self.reply(401, {"error": {"code": "unauthorized", "message": "Unknown caller."}})
        if body["action"] == "pair":
            if body["code"] == "482913":
                return self.reply(200, {"paired": True, "pairing_id": PAIRING, **CONTEXT})
            return self.reply(200, {"paired": False, "attempts_left": 3})
        if body["action"] == "resolve":
            return self.reply(404, {"error": {"code": "pairing_invalid", "message": "expired"}})
        return self.reply(200, {"ok": True, "saved": True})

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class MetadataTests(unittest.TestCase):
    def test_in_game_call_is_the_pairing_uuid(self):
        self.assertEqual(parse_metadata(PAIRING.upper()), Dispatch(pairing_id=PAIRING))

    def test_facetime_call_names_only_the_call(self):
        d = parse_metadata(json.dumps({"facetime_call": CALL, "player_id": "attacker", "npc_id": "x"}))
        self.assertEqual(d, Dispatch(call_id=CALL))
        self.assertTrue(d.facetime)

    def test_anything_else_is_a_locked_call(self):
        for meta in ("", "hello", "{}", json.dumps({"facetime_call": "room-1"}), json.dumps([PAIRING]), None):
            self.assertEqual(parse_metadata(meta), Dispatch(), meta)


class InstructionTests(unittest.TestCase):
    def test_locked_call_reveals_no_teacher_or_coursework(self):
        state = CallState(dispatch=Dispatch(call_id=CALL))
        text = locked_instructions(state)
        self.assertIn("6-digit", text)
        self.assertNotIn("Maple", text)
        self.assertFalse(state.paired)

    def test_paired_call_becomes_the_teacher_and_is_honest_about_the_camera(self):
        state = CallState(dispatch=Dispatch(call_id=CALL), pairing_id=PAIRING, context=CONTEXT)
        self.assertTrue(state.paired)
        self.assertEqual(state.teacher, "Professor Maple")
        self.assertIn("You are Professor Maple", paired_instructions(state))
        self.assertIn("no video is being received", paired_instructions(state))
        state.camera_on = True
        self.assertIn("live video", paired_instructions(state))
        self.assertIn("cannot see", camera_line(False))

    def test_context_digest_has_no_ids(self):
        digest = context_digest(CONTEXT)
        self.assertEqual(digest["teacher"], "Professor Maple")
        self.assertEqual(digest["coursework_titles"], ["Fractions worksheet"])
        self.assertNotIn("room", digest)

    def test_fallback_summary_never_stores_raw_speech(self):
        self.assertEqual(fallback_summary("Professor Maple", ["Student: my address is ..."], []), "Voice call with Professor Maple: a short tutoring conversation.")
        self.assertIn("fractions", fallback_summary("Professor Maple", [], ["fractions"]))
        self.assertEqual(fallback_summary("X", [], []), "")
        self.assertIn("pair_with_code", LOCKED_INSTRUCTIONS)


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeVoiceAgent)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/functions/v1/voice-agent"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeVoiceAgent.calls.clear()

    def test_requires_configuration(self):
        with self.assertRaises(ValueError):
            Backend("", SECRET)
        with self.assertRaises(ValueError):
            Backend(self.url, "")

    def test_pair_sends_the_secret_and_only_call_id_plus_code(self):
        api = Backend(self.url, SECRET)
        ok = asyncio.run(api.pair(CALL, "482913"))
        self.assertTrue(ok["paired"])
        self.assertEqual(ok["npc"]["name"], "Professor Maple")
        auth, body = FakeVoiceAgent.calls[-1]
        self.assertEqual(auth, f"Bearer {SECRET}")
        self.assertEqual(body, {"action": "pair", "call_id": CALL, "code": "482913"})
        wrong = asyncio.run(api.pair(CALL, "000000"))
        self.assertEqual(wrong, {"paired": False, "attempts_left": 3})

    def test_errors_carry_status_and_code(self):
        with self.assertRaises(BackendError) as caught:
            asyncio.run(Backend(self.url, "wrong-secret").pair(CALL, "482913"))
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "unauthorized"))
        with self.assertRaises(BackendError) as expired:
            asyncio.run(Backend(self.url, SECRET).resolve(PAIRING))
        self.assertEqual((expired.exception.status, expired.exception.code), (404, "pairing_invalid"))

    def test_end_and_call_ended_shapes(self):
        api = Backend(self.url, SECRET)
        asyncio.run(api.end(PAIRING, "Practised the power rule.", ["power rule"]))
        asyncio.run(api.call_ended(CALL))
        self.assertEqual([b for _, b in FakeVoiceAgent.calls], [
            {"action": "end", "pairing_id": PAIRING, "summary": "Practised the power rule.", "topics": ["power rule"]},
            {"action": "call_ended", "call_id": CALL},
        ])


if __name__ == "__main__":
    unittest.main()
