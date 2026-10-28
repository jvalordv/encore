"""Tests for the separation model code with real torch tensors and demucs.

No weights are downloaded. The models here are demucs's own architectures,
made small and left with random weights, so they run in a fraction of a second
and what they output is noise. What is checked is the plumbing around a model:
shapes, sample rates, normalising and restoring, the options demucs is run
with, progress, memory failures, loading and the step run end to end. The file
is skipped where torch or demucs is not installed, as in CI, and the CUDA
tests where there is no GPU.
"""

import weakref
from collections.abc import Callable
from fractions import Fraction
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_service import registry, separation
from encore_service.separation import (
    OUT_OF_MEMORY,
    DemucsSeparator,
    SeparationError,
    combine_stems,
    normalise,
    separate_vocals,
)
from encore_service.store import SongStore
from tests.fakes import (
    REAL_LOAD_DEMUCS,
    add_song,
    read_stem,
    song_files,
    stereo_tone,
)

torch = pytest.importorskip("torch")
demucs_apply = pytest.importorskip("demucs.apply")
demucs_htdemucs = pytest.importorskip("demucs.htdemucs")
demucs_pretrained = pytest.importorskip("demucs.pretrained")
pytest.importorskip("julius")

SOURCES = ["drums", "bass", "other", "vocals"]
MODEL_RATE = 44_100


def tiny_htdemucs(seed: int = 0, segment: Fraction = Fraction(1, 2)) -> Any:
    """A very small hybrid transformer demucs, as the htdemucs models are."""
    torch.manual_seed(seed)
    return demucs_htdemucs.HTDemucs(
        sources=SOURCES,
        audio_channels=2,
        channels=8,
        depth=3,
        t_layers=2,
        t_heads=2,
        nfft=512,
        samplerate=MODEL_RATE,
        segment=segment,
        bottom_channels=0,
        kernel_size=8,
        stride=4,
        time_stride=2,
        dconv_depth=1,
        dconv_comp=4,
        growth=2,
        t_hidden_scale=2.0,
    )


def noise(seconds: float, rate: int = MODEL_RATE, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (0.1 * rng.standard_normal((2, int(seconds * rate)))).astype(np.float32)


def dominant_hz(samples: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size)))
    return float(np.argmax(spectrum) * rate / samples.size)


class Quarter(torch.nn.Module):
    """A model whose four sources are each a quarter of what it is given.

    Not a separation, but one whose answer is known, so that what is done around
    a model (resampling, normalising and undoing it) can be checked exactly.
    """

    samplerate = MODEL_RATE
    audio_channels = 2
    sources = SOURCES
    segment = 10

    def forward(self, mix: Any) -> Any:
        return mix.unsqueeze(1).repeat(1, len(SOURCES), 1, 1) * 0.25


class Recorder(torch.nn.Module):
    """A model that notes what it is given and answers in fixed shares of it.

    The shares differ, so which source is which shows, and they add up to one,
    so its sources add up to what it was given, as a separation's are meant to.
    """

    samplerate = MODEL_RATE
    audio_channels = 2
    sources = SOURCES
    segment = 10
    shares = (0.1, 0.2, 0.3, 0.4)

    def __init__(self) -> None:
        super().__init__()
        self.heard: list[Any] = []

    def forward(self, mix: Any) -> Any:
        self.heard.append(mix.clone())
        shares = mix.new_tensor(self.shares).reshape(1, -1, 1, 1)
        return mix.unsqueeze(1) * shares


class FakeModel:
    """A loaded demucs model that is moved onto a device, or cannot be.

    `fail`, if given, makes the error that each move raises. `moves` lists the
    devices it was moved to.
    """

    samplerate = MODEL_RATE

    def __init__(
        self,
        sources: list[str] | None = None,
        fail: Callable[[], BaseException] | None = None,
    ) -> None:
        self.sources = SOURCES if sources is None else sources
        self.fail = fail
        self.moves: list[str] = []

    def to(self, device: str) -> "FakeModel":
        self.moves.append(device)
        if self.fail is not None:
            raise self.fail()
        return self


def serve_models(
    monkeypatch: pytest.MonkeyPatch, make: Callable[[], FakeModel]
) -> list[weakref.ref[FakeModel]]:
    """Have demucs's get_model hand out models made by `make`, with no download.

    Returns weak references to the models handed out, which say whether one is
    still alive when the test asks.
    """
    handed_out: list[weakref.ref[FakeModel]] = []

    def get_model(name: str) -> FakeModel:
        model = make()
        handed_out.append(weakref.ref(model))
        return model

    monkeypatch.setattr(demucs_pretrained, "get_model", get_model)
    return handed_out


AppliedCall = tuple[Any, Any, dict[str, Any]]


def spy_on_apply_model(monkeypatch: pytest.MonkeyPatch) -> list[AppliedCall]:
    """Record the calls to demucs's apply_model as (model, mix, options).

    The real function still runs. It calls itself by the module's name for it,
    so the calls it makes on the pieces of a song are recorded too, after the
    first, which is the one the separator made.
    """
    calls: list[AppliedCall] = []
    real = demucs_apply.apply_model

    def spy(model: Any, mix: Any, **options: Any) -> Any:
        calls.append((model, mix, options))
        return real(model, mix, **options)

    monkeypatch.setattr(demucs_apply, "apply_model", spy)
    return calls


# --- the plumbing around a real model ---------------------------------------


def test_a_bag_of_hybrid_transformer_models_splits_audio_into_its_sources() -> None:
    bag = demucs_apply.BagOfModels([tiny_htdemucs(0), tiny_htdemucs(1)])
    separator = DemucsSeparator(bag, "cpu")
    reported: list[float] = []

    stems = separator.separate(noise(2.0), MODEL_RATE, reported.append)

    assert separator.samplerate == MODEL_RATE
    assert list(stems) == SOURCES
    for stem in stems.values():
        assert stem.shape == (2, 2 * MODEL_RATE) and stem.dtype == np.float32
        assert np.isfinite(stem).all()
    # Progress covers both models of the bag, from near nothing to near the cap.
    assert reported == sorted(reported)
    assert len(reported) > 8
    assert reported[0] < 0.2
    assert 0.8 < reported[-1] <= separation.PROGRESS_CAP


def test_a_single_model_works_like_a_bag_of_one() -> None:
    model = demucs_pretrained.get_model("demucs_unittest")
    model.segment = 0.5  # seconds, so a short clip is cut into several segments
    reported: list[float] = []

    stems = DemucsSeparator(model, "cpu").separate(
        noise(2.0), MODEL_RATE, reported.append
    )

    assert list(stems) == SOURCES
    assert all(np.isfinite(stem).all() for stem in stems.values())
    assert reported == sorted(reported)
    assert 0.7 < reported[-1] <= separation.PROGRESS_CAP


def test_audio_at_another_rate_is_resampled_to_the_models() -> None:
    separator = DemucsSeparator(tiny_htdemucs(), "cpu")

    stems = separator.separate(noise(1.0, 48_000), 48_000, lambda value: None)

    frames = stems["vocals"].shape[1]
    # A second of 48 kHz audio is a second of 44.1 kHz audio, to a sample.
    assert abs(frames - MODEL_RATE) <= 1


@pytest.mark.parametrize("offset", [0.0, 0.1, -0.07])
def test_what_surrounds_a_model_gives_its_answer_back_at_the_right_level(
    offset: float,
) -> None:
    wav = stereo_tone(1.0, MODEL_RATE) + np.float32(offset)

    stems = DemucsSeparator(Quarter(), "cpu").separate(wav, MODEL_RATE, lambda v: None)

    # Normalised on the way in and restored on the way out: each source is the
    # model's quarter of the song, on the song's own sides and at its level,
    # that of a song with a mean of its own included.
    for stem in stems.values():
        np.testing.assert_allclose(stem, wav * 0.25, atol=1e-5)


def test_the_model_hears_a_normalised_song_and_the_mean_goes_back_once() -> None:
    rng = np.random.default_rng(7)
    # Quiet, and riding on a level of its own, so that leaving out either the
    # normalising or the restoring changes the answer.
    wav = (0.05 * rng.standard_normal((2, MODEL_RATE)) + 0.2).astype(np.float32)
    model = Recorder()

    stems = DemucsSeparator(model, "cpu").separate(wav, MODEL_RATE, lambda v: None)

    [heard] = model.heard
    # The random shift of the demucs command can put silence ahead of the
    # song; the song itself is the last of what the model hears.
    song = heard[0, :, -wav.shape[1] :].numpy().astype(np.float64)
    reference = song.mean(axis=0)
    assert abs(reference.mean()) < 1e-4
    assert reference.std(ddof=1) == pytest.approx(1.0, abs=1e-3)
    # Each source is its share of the song, centred as the model saw it, plus
    # its part of the song's mean.
    mean = float(wav.mean())
    for name, share in zip(SOURCES, Recorder.shares, strict=True):
        expected = share * (wav - mean) + mean / len(SOURCES)
        np.testing.assert_allclose(stems[name], expected, atol=1e-5)
    # So, for a model whose shares add up to one, the voice and the backing add
    # up to the song, not to it and its mean over again for each source after
    # the first.
    vocals, no_vocals = combine_stems(stems)
    np.testing.assert_allclose(vocals + no_vocals, wav, atol=1e-5)


@pytest.mark.parametrize("rate", [MODEL_RATE, 48_000])
def test_the_model_is_run_as_the_demucs_command_runs_it(
    monkeypatch: pytest.MonkeyPatch, rate: int
) -> None:
    calls = spy_on_apply_model(monkeypatch)
    model = tiny_htdemucs()
    reported: list[float] = []

    DemucsSeparator(model, "cpu").separate(noise(1.0, rate), rate, reported.append)

    [(called, mix, options), *_] = calls
    assert called is model
    # One song, in stereo, at the model's rate whatever the file's was.
    assert mix.shape[:2] == (1, 2) and abs(mix.shape[2] - MODEL_RATE) <= 1
    assert options["shifts"] == 1
    assert options["split"] is True
    assert options["overlap"] == 0.25
    assert options["num_workers"] == 0
    assert options["device"] == "cpu"
    # Progress is counted in the samples the model is given, and reaches the
    # step's report. Nothing else is asked of demucs.
    assert options["callback_arg"] == {"audio_length": mix.shape[2]}
    assert callable(options["callback"]) and reported
    assert set(options) == {
        "shifts",
        "split",
        "overlap",
        "num_workers",
        "device",
        "callback",
        "callback_arg",
    }


def test_resampling_keeps_the_pitch_and_the_level() -> None:
    rate = 48_000
    t = np.arange(rate) / rate
    wav = np.stack([0.5 * np.sin(2 * np.pi * 1_000 * t)] * 2).astype(np.float32)

    stems = DemucsSeparator(Quarter(), "cpu").separate(wav, rate, lambda v: None)

    vocals = stems["vocals"]
    middle = vocals[0, 10_000 : 10_000 + 8_192]
    assert dominant_hz(middle, MODEL_RATE) == pytest.approx(1_000, abs=6)
    assert float(np.abs(middle).max()) == pytest.approx(0.125, rel=0.03)


def test_normalising_is_what_torch_does_to_a_song() -> None:
    rng = np.random.default_rng(5)
    wav = (0.2 * rng.standard_normal((2, 30_000)) + 0.03).astype(np.float32)

    ours, mean, std = normalise(wav)

    tensor = torch.from_numpy(wav)
    reference = tensor.mean(0)
    # The demucs command's own lines, with the deviation torch gives (n - 1).
    expected = (tensor - reference.mean()) / (reference.std() + 1e-8)
    np.testing.assert_allclose(ours, expected.numpy(), atol=1e-5)
    assert mean == pytest.approx(float(reference.mean()), abs=1e-7)
    assert std == pytest.approx(float(reference.std()) + 1e-8, rel=1e-5)


# --- running out of memory ----------------------------------------------------


@pytest.fixture
def cache_emptied(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Count the times the CUDA cache is emptied, which needs no GPU."""
    calls: list[str] = []
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: calls.append("empty"))
    return calls


def failing_model(monkeypatch: pytest.MonkeyPatch, error: BaseException) -> None:
    def apply_model(*args: Any, **kwargs: Any) -> Any:
        raise error

    monkeypatch.setattr(demucs_apply, "apply_model", apply_model)


@pytest.mark.parametrize(
    "error",
    [
        torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB"),
        RuntimeError("CUDA error: out of memory"),
        RuntimeError("cuDNN error: CUDNN_STATUS_ALLOC_FAILED. CUDA Out Of Memory"),
    ],
)
def test_running_out_of_gpu_memory_becomes_advice_and_frees_the_cache(
    monkeypatch: pytest.MonkeyPatch, cache_emptied: list[str], error: BaseException
) -> None:
    failing_model(monkeypatch, error)
    separator = DemucsSeparator(tiny_htdemucs(), "cuda")

    with pytest.raises(SeparationError) as raised:
        separator.separate(noise(0.5), MODEL_RATE, lambda value: None)

    assert str(raised.value) == (
        "The GPU ran out of memory while separating. Close other programs using "
        "the GPU, or set ENCORE_DEVICE=cpu (much slower)."
    )
    assert str(raised.value) == OUT_OF_MEMORY
    assert cache_emptied == ["empty"]
    # Raised outside the handler and not chained: the failed pass's tensors are
    # held by the original error's traceback, and the cache cannot give them
    # back while that is alive.
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None


def test_another_failure_on_the_gpu_is_not_called_a_memory_problem(
    monkeypatch: pytest.MonkeyPatch, cache_emptied: list[str]
) -> None:
    failing_model(monkeypatch, RuntimeError("CUDA error: an illegal memory access"))
    separator = DemucsSeparator(tiny_htdemucs(), "cuda")

    with pytest.raises(RuntimeError, match="illegal memory access"):
        separator.separate(noise(0.5), MODEL_RATE, lambda value: None)

    assert cache_emptied == []


def test_a_memory_error_on_the_cpu_is_not_the_gpus(
    monkeypatch: pytest.MonkeyPatch, cache_emptied: list[str]
) -> None:
    failing_model(monkeypatch, RuntimeError("DefaultCPUAllocator: out of memory"))
    separator = DemucsSeparator(tiny_htdemucs(), "cpu")

    # Not rewritten as advice to run on the CPU, and nothing to free there.
    with pytest.raises(RuntimeError, match="DefaultCPUAllocator"):
        separator.separate(noise(0.5), MODEL_RATE, lambda value: None)

    assert cache_emptied == []


@pytest.mark.parametrize(
    "make_error",
    [
        lambda: torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate"),
        lambda: RuntimeError("CUDA error: out of memory"),
    ],
)
def test_running_out_of_gpu_memory_while_loading_becomes_advice_too(
    monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], BaseException]
) -> None:
    handed_out = serve_models(monkeypatch, lambda: FakeModel(fail=make_error))
    still_held_when_emptied: list[bool] = []

    def empty_cache() -> None:
        still_held_when_emptied.append(any(ref() is not None for ref in handed_out))

    monkeypatch.setattr(torch.cuda, "empty_cache", empty_cache)

    with pytest.raises(SeparationError) as raised:
        REAL_LOAD_DEMUCS("htdemucs_ft", "cuda")

    assert str(raised.value) == OUT_OF_MEMORY
    # The model, which may be part way onto the GPU, was let go of before the
    # cache was emptied, or its share of the memory could not be handed back.
    assert still_held_when_emptied == [False]
    assert raised.value.__cause__ is None and raised.value.__context__ is None


@pytest.mark.parametrize(
    ("device", "message"),
    [
        ("cuda", "CUDA error: an illegal memory access"),
        ("cpu", "DefaultCPUAllocator: out of memory"),
    ],
)
def test_another_failure_while_loading_is_not_called_a_memory_problem(
    monkeypatch: pytest.MonkeyPatch,
    cache_emptied: list[str],
    device: str,
    message: str,
) -> None:
    serve_models(monkeypatch, lambda: FakeModel(fail=lambda: RuntimeError(message)))

    with pytest.raises(RuntimeError, match=message):
        REAL_LOAD_DEMUCS("htdemucs_ft", device)

    assert cache_emptied == []


def test_running_out_of_gpu_memory_while_loading_reaches_the_step_as_the_advice(
    store: SongStore, monkeypatch: pytest.MonkeyPatch, cache_emptied: list[str]
) -> None:
    # No GPU is needed: the move onto it is faked.
    monkeypatch.setenv("ENCORE_DEVICE", "cuda")
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    serve_models(
        monkeypatch,
        lambda: FakeModel(fail=lambda: torch.cuda.OutOfMemoryError("CUDA out of")),
    )
    song_id = add_song(store)

    with pytest.raises(SeparationError) as raised:
        separate_vocals(store, song_id, lambda value: None)

    # Not "Loading the separation model failed: CUDA out of memory...".
    assert str(raised.value) == OUT_OF_MEMORY
    assert cache_emptied == ["empty"]
    assert registry.loaded_models() == []
    assert song_files(store, song_id) == ["meta.json", "source.wav", "status.json"]


# --- a model that cannot do the job -------------------------------------------


def test_a_model_with_no_voice_is_refused_as_it_loads_before_it_takes_gpu_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = FakeModel(sources=["drums", "bass", "other"])
    monkeypatch.setattr(demucs_pretrained, "get_model", lambda name: model)

    with pytest.raises(ValueError) as raised:
        REAL_LOAD_DEMUCS("a_model_with_no_voice", "cuda")

    assert (
        str(raised.value) == "the model makes no vocals source, only drums, bass, other"
    )
    assert model.moves == []


def test_a_model_with_no_voice_fails_the_step_before_any_audio_is_read(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENCORE_DEVICE", "cpu")
    monkeypatch.setenv("ENCORE_DEMUCS_MODEL", "a_model_with_no_voice")
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    serve_models(monkeypatch, lambda: FakeModel(sources=["drums", "bass"]))

    def read(path: Any, scratch: Any) -> Any:
        raise AssertionError("the audio was read before the model was ready")

    monkeypatch.setattr(separation, "read_audio", read)
    song_id = add_song(store)

    with pytest.raises(SeparationError) as raised:
        separate_vocals(store, song_id, lambda value: None)

    assert str(raised.value) == (
        "Loading the separation model failed: "
        "the model makes no vocals source, only drums, bass"
    )
    # Never kept as loaded, so the next song asks for it afresh.
    assert registry.loaded_models() == []
    assert song_files(store, song_id) == ["meta.json", "source.wav", "status.json"]


# --- loading, and the step end to end -----------------------------------------


def test_the_loader_returns_a_model_on_the_device_ready_to_separate() -> None:
    separator = REAL_LOAD_DEMUCS("demucs_unittest", "cpu")

    assert isinstance(separator, DemucsSeparator)
    assert separator.samplerate == MODEL_RATE
    stems = separator.separate(noise(0.5), MODEL_RATE, lambda value: None)
    assert list(stems) == SOURCES


def test_the_step_runs_end_to_end_on_a_real_model(
    store: SongStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENCORE_DEVICE", "cpu")
    monkeypatch.setenv("ENCORE_DEMUCS_MODEL", "demucs_unittest")
    monkeypatch.setattr(separation, "load_demucs", REAL_LOAD_DEMUCS)
    song_id = add_song(store, duration_s=None)  # one second at 8 kHz
    reported: list[float] = []

    separate_vocals(store, song_id, reported.append)

    assert song_files(store, song_id) == [
        "meta.json",
        "no_vocals.flac",
        "source.wav",
        "status.json",
        "vocals.flac",
    ]
    for stem in ("vocals", "no_vocals"):
        path = store.stem_path(song_id, stem)
        assert path is not None
        info = sf.info(str(path))
        # The model's rate, not the song's: resampled from 8 kHz on the way in.
        assert (info.subtype, info.samplerate, info.channels) == ("PCM_24", 44_100, 2)
        assert abs(info.frames - MODEL_RATE) <= 1
        assert np.isfinite(read_stem(store, song_id, stem)).all()
    meta = store.read_meta(song_id)
    assert meta is not None and meta.duration_s == pytest.approx(1.0)
    assert reported[-1] == 1.0
    assert registry.loaded_models() == ["demucs:demucs_unittest@cpu"]


@pytest.mark.skipif(not torch.cuda.is_available(), reason="no CUDA device")
def test_the_model_stays_on_the_gpu_and_separates_there(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loaded: list[Any] = []
    real_get_model = demucs_pretrained.get_model

    def get_model(name: str) -> Any:
        loaded.append(real_get_model(name))
        return loaded[-1]

    # The model as demucs built it, kept to look at where it lives.
    monkeypatch.setattr(demucs_pretrained, "get_model", get_model)
    separator = REAL_LOAD_DEMUCS("demucs_unittest", "cuda")
    reported: list[float] = []

    stems = separator.separate(noise(1.0), MODEL_RATE, reported.append)

    # Kept on the device between songs, not moved back after each.
    [model] = loaded
    assert next(model.parameters()).device.type == "cuda"
    assert list(stems) == SOURCES
    for stem in stems.values():
        assert stem.shape == (2, MODEL_RATE) and stem.dtype == np.float32
        assert np.isfinite(stem).all()


@pytest.mark.skipif(not torch.cuda.is_available(), reason="no CUDA device")
def test_a_bag_of_hybrid_transformer_models_separates_on_the_gpu() -> None:
    bag = demucs_apply.BagOfModels([tiny_htdemucs(0), tiny_htdemucs(1)])
    bag.to("cuda")
    reported: list[float] = []

    stems = DemucsSeparator(bag, "cuda").separate(
        noise(2.0, 48_000), 48_000, reported.append
    )

    assert abs(stems["vocals"].shape[1] - 2 * MODEL_RATE) <= 1
    assert all(np.isfinite(stem).all() for stem in stems.values())
    assert reported == sorted(reported)
    assert 0.8 < reported[-1] <= separation.PROGRESS_CAP
