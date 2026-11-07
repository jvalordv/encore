"""HTTP tests for `POST /songs/{id}/align` and the capture cross-check.

Songs are synthetic chord progressions uploaded through the real routes; the
app runs its real job queue over a temporary cache, as in test_songs.py.
"""

import io
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from encore_service import align_job, pipeline, reference
from encore_service.app import create_app
from encore_service.config import Settings
from encore_service.schemas import (
    Contour,
    KeyMap,
    KeySegment,
    MidiRange,
    Note,
    Reference,
)
from tests.audio_synth import (
    OTHER_PROGRESSION,
    PROGRESSION,
    RATE,
    random_song,
    render,
)

WAIT_S = 60.0
SECONDS = 24.0


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        yield client


def wav(audio: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, audio, RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def upload(client: TestClient, audio: np.ndarray) -> str:
    body = client.post(
        "/songs", files={"file": ("a.wav", wav(audio), "audio/wav")}
    ).json()
    # Preparation must have settled, or the align route turns the song away.
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)
    return body["song_id"]


def give_melody(client: TestClient, song_id: str) -> None:
    """A steady A4 from 4 s to 6 s over a contour that sings throughout."""
    frames = int(SECONDS / 0.01)
    reference = Reference(
        contour=Contour(hop_s=0.01, f0_hz=[440.0] * frames, confidence=[0.9] * frames),
        notes=[
            Note(
                onset_s=4.0,
                offset_s=6.0,
                midi=69.0,
                cents_mean=0.0,
                cents_std=5.0,
                scoop_cents=0.0,
            )
        ],
        range=MidiRange(low_midi=69.0, high_midi=69.0),
    )
    client.app.state.store.write_reference(song_id, reference)
    client.app.state.store.write_key(
        song_id,
        KeyMap(
            tuning_cents=0.0,
            segments=[
                KeySegment(
                    start_s=0, end_s=SECONDS, tonic=9, mode="minor", confidence=0.8
                )
            ],
        ),
    )


def settle(client: TestClient) -> None:
    assert client.app.state.jobs.wait_idle(timeout=WAIT_S)


def test_a_karaoke_song_gets_the_originals_melody_shifted_and_warped(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    karaoke = upload(client, render(PROGRESSION, transpose=2, stretch=1.05))
    give_melody(client, original)

    response = client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    assert response.status_code == 200
    assert response.json()["alignment"]["original_id"] == original
    settle(client)

    status = client.get(f"/songs/{karaoke}").json()
    assert status["alignment"]["state"] == "done"
    assert status["alignment"]["key_offset"] == 2
    assert status["alignment"]["confidence"] > 0.5
    reference = client.get(f"/songs/{karaoke}/reference").json()
    assert reference["aligned_from"] == original
    assert reference["key_offset"] == 2
    note = reference["notes"][0]
    assert note["midi"] == pytest.approx(71.0)
    assert note["onset_s"] == pytest.approx(4.0 * 1.05, abs=0.3)
    assert note["offset_s"] == pytest.approx(6.0 * 1.05, abs=0.3)
    # 440 Hz two semitones up, at a moment inside the note.
    contour = reference["contour"]
    at = int(5.0 / contour["hop_s"])
    assert contour["f0_hz"][at] == pytest.approx(440 * 2 ** (2 / 12), rel=1e-3)
    key = client.get(f"/songs/{karaoke}/key").json()
    assert key["segments"][0]["tonic"] == 11
    assert key["segments"][-1]["end_s"] == pytest.approx(SECONDS * 1.05, abs=0.2)


def test_a_reload_adopts_the_aligned_melody_and_preparation_keeps_it(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    karaoke = upload(client, render(PROGRESSION, transpose=2, stretch=1.05))
    give_melody(client, original)
    client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    settle(client)
    store = client.app.state.store

    # What a reloaded browser reads: the steps say the files are there.
    steps = client.get(f"/songs/{karaoke}").json()["steps"]
    assert steps["reference"]["state"] == "done"
    assert steps["key"]["state"] == "done"
    before = store.reference_path(karaoke).read_bytes()

    # Preparing the song again judges every step afresh; the aligned
    # reference neither reverts to skipped nor is replaced.
    pipeline.prepare(store, karaoke)
    reference.extract_reference(store, karaoke, lambda progress: None)
    after = store.read_status(karaoke)
    assert after is not None
    assert after.steps.reference.state == "done"
    assert after.steps.key.state == "done"
    assert store.reference_path(karaoke).read_bytes() == before


def test_a_reference_step_whose_file_has_gone_is_not_done(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    karaoke = upload(client, render(PROGRESSION, transpose=2, stretch=1.05))
    give_melody(client, original)
    client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    settle(client)
    store = client.app.state.store
    store.reference_path(karaoke).unlink()
    status = store.read_status(karaoke)
    assert status is not None
    assert not pipeline._is_done(store, karaoke, "reference", status)


def test_a_malformed_original_key_fails_the_job_and_borrows_nothing(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    karaoke = upload(client, render(PROGRESSION, transpose=2, stretch=1.05))
    give_melody(client, original)
    store = client.app.state.store
    store.key_path(original).write_text("{not json", encoding="utf-8")

    client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    settle(client)

    status = client.get(f"/songs/{karaoke}").json()
    assert status["alignment"]["state"] == "failed"
    assert store.reference_path(karaoke) is None
    assert store.key_path(karaoke) is None
    assert status["steps"]["reference"]["state"] != "done"
    assert client.get(f"/songs/{karaoke}/reference").status_code == 409


def test_the_route_waits_for_the_karaoke_song_to_be_prepared(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    karaoke = upload(client, render(PROGRESSION, transpose=2, stretch=1.05))
    give_melody(client, original)
    store = client.app.state.store
    for step in ("separation", "reference"):
        store.update_step(karaoke, step, state="running", progress=0.3)
        response = client.post(
            f"/songs/{karaoke}/align", json={"original_id": original}
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "The karaoke song is still being prepared."
        store.update_step(karaoke, step, state="skipped", progress=0.0)
    ok = client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    assert ok.status_code == 200
    settle(client)


def test_an_unrelated_arrangement_is_refused_and_writes_nothing(
    client: TestClient,
) -> None:
    original = upload(client, render(PROGRESSION, vocal=True))
    other = upload(client, render(OTHER_PROGRESSION, bar_s=1.3))
    give_melody(client, original)

    client.post(f"/songs/{other}/align", json={"original_id": original})
    settle(client)

    alignment = client.get(f"/songs/{other}").json()["alignment"]
    assert alignment["state"] == "refused"
    assert "Open scoring uses the key" in alignment["reason"]
    assert client.get(f"/songs/{other}/reference").status_code == 409


def test_the_route_refuses_what_cannot_be_aligned(client: TestClient) -> None:
    original = upload(client, render(PROGRESSION, bars=2))
    karaoke = upload(client, render(PROGRESSION, bars=3))

    no_melody = client.post(f"/songs/{karaoke}/align", json={"original_id": original})
    same = client.post(f"/songs/{karaoke}/align", json={"original_id": karaoke})
    unknown = client.post(f"/songs/{karaoke}/align", json={"original_id": "0" * 64})

    assert no_melody.status_code == 422
    assert "no melody" in no_melody.json()["detail"]
    assert same.status_code == 422
    assert unknown.status_code == 404


def test_a_capture_offset_is_found_beside_a_download(
    client: TestClient, tmp_path: Path
) -> None:
    video = "dQw4w9WgXcQ"
    song_id = f"yt-{video}"
    download = render(PROGRESSION)
    # The capture starts 1.5 s later in its own clock: silence first.
    capture = np.concatenate([np.zeros(int(1.5 * RATE), dtype=np.float32), download])
    client.post(
        f"/songs/url/{video}/capture",
        files={"audio": ("c.wav", wav(download), "audio/wav")},
        data={"title": "t"},
    )
    settle(client)
    store = client.app.state.store
    store.set_audio_source(song_id, "download")

    client.post(
        f"/songs/url/{video}/capture",
        files={"audio": ("c.wav", wav(capture), "audio/wav")},
    )
    settle(client)

    offset = client.get(f"/songs/{song_id}").json()["capture_offset_s"]
    assert offset == pytest.approx(1.5, abs=0.2)


def capture_file(client: TestClient, song_id: str) -> Path:
    return client.app.state.store.song_dir(song_id) / align_job.CAPTURE_FILE


def test_an_unreadable_capture_leaves_no_offset(client: TestClient) -> None:
    song_id = upload(client, render(PROGRESSION))
    capture_file(client, song_id).write_bytes(b"this is not audio")

    align_job.check_capture(client.app.state.store, song_id)

    status = client.get(f"/songs/{song_id}").json()
    assert status["capture_offset_s"] is None


def test_a_capture_that_does_not_match_leaves_no_offset(client: TestClient) -> None:
    song_id = upload(client, render(PROGRESSION))
    sf.write(
        str(capture_file(client, song_id)),
        random_song(3, bars=24, bar_s=1.0),
        RATE,
    )

    align_job.check_capture(client.app.state.store, song_id)

    assert client.get(f"/songs/{song_id}").json()["capture_offset_s"] is None


def test_a_song_without_a_capture_is_left_alone(client: TestClient) -> None:
    song_id = upload(client, render(PROGRESSION))
    align_job.check_capture(client.app.state.store, song_id)
    assert client.get(f"/songs/{song_id}").json()["capture_offset_s"] is None
