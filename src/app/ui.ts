/**
 * The shell's controls, mounted without a framework onto the markup in
 * index.html. The UI is a thin skin over the Session: every control calls one
 * Session intent, and everything drawn is a function of the AppState, redrawn
 * per changed key when the store announces a change. Colour, type and motion
 * come from skin tokens through src/style.css; this file only sets
 * attributes, text and a few widths, so a new skin never touches it. Keyboard
 * shortcuts live here too (Space, R, L, [ ], arrows) because they are the same
 * intents as the buttons. Importing the file touches no DOM; mountUI does.
 */
import type { Session } from './session';
import { describeHealth, describeMonitor, describePitch, formatClock, meterFraction } from './state';
import type { AppState } from './state';
import type { TakeSummary } from './takes';

/** What mountUI hands back. */
export interface UI {
  /** Removes every listener and stops listening to the store. */
  dispose(): void;
}

/** Select values for "nothing chosen yet" and "the system default". */
const NONE = '@none';
const DEFAULT = '@default';
/** Seconds the arrow keys seek; Shift narrows it. */
const SEEK_STEP_S = 5;
const SEEK_STEP_FINE_S = 1;
/** Mic peaks above these read as "hot" and "clipping" on the meter. */
const METER_HOT = 0.7;
const METER_CLIP = 0.98;
/** The tuner calls a note in tune within this many cents (docs/COACHING.md). */
const TUNER_HIT_CENTS = 25;
/** The note readout lingers this long through a breath or a consonant. */
const PITCH_HOLD_MS = 300;
/** A first Delete press waits this long for a confirming second press. */
const DELETE_ARM_MS = 3000;
const AUDIO_NAME = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm)$/i;

function must<T extends HTMLElement>(root: ParentNode, id: string): T {
  const found = root.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found;
}

function option(value: string, text: string, hidden = false): HTMLOptionElement {
  const o = new Option(text, value);
  o.hidden = hidden;
  o.disabled = hidden;
  return o;
}

/** True for controls that use the keys themselves, so shortcuts step aside. */
function usesKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return true;
  // The seek slider is excluded: its own arrows would move by 10 ms.
  return target.tagName === 'INPUT' && target.id !== 'seek-input';
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_NAME.test(file.name);
}

/** Wires the page's controls to the session and keeps them in step. */
export function mountUI(session: Session, root: Document = document): UI {
  const { store } = session;
  const get = <T extends HTMLElement>(id: string): T => must<T>(root, id);
  const dropzone = get('dropzone');
  const songInput = get<HTMLInputElement>('song-input');
  const songTitle = get('song-title');
  const songDuration = get('song-duration');
  const inputSelect = get<HTMLSelectElement>('input-select');
  const outputSelect = get<HTMLSelectElement>('output-select');
  const refreshButton = get<HTMLButtonElement>('refresh-devices');
  const micToggle = get<HTMLButtonElement>('mic-toggle');
  const monitorButtons = [...get('monitor-mode').querySelectorAll<HTMLButtonElement>('button[data-mode]')];
  const meter = get('mic-meter');
  const meterFill = get('mic-meter-fill');
  const processing = get('mic-processing');
  const latencyInput = get<HTMLInputElement>('latency-input');
  const calibrateButton = get<HTMLButtonElement>('calibrate-button');
  const clarityInput = get<HTMLInputElement>('clarity-input');
  const clarityValue = get('clarity-value');
  const takeList = get('take-list');
  const takeEmpty = get('take-empty');
  const pitchReadout = get('pitch-readout');
  const pitchNote = get('pitch-note');
  const pitchCents = get('pitch-cents');
  const tunerMarker = get('tuner-marker');
  const stopButton = get<HTMLButtonElement>('stop-button');
  const playButton = get<HTMLButtonElement>('play-button');
  const recordButton = get<HTMLButtonElement>('record-button');
  const timeReadout = get('time-readout');
  const seekInput = get<HTMLInputElement>('seek-input');
  const loopA = get<HTMLButtonElement>('loop-a');
  const loopB = get<HTMLButtonElement>('loop-b');
  const loopToggle = get<HTMLButtonElement>('loop-clear');
  const loopReadout = get('loop-readout');
  const statusText = get('status-text');
  const statusHealth = get('status-health');

  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };
  const listenDoc = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (ev: DocumentEventMap[K]) => void,
  ): void => {
    root.addEventListener(type, handler);
    cleanups.push(() => root.removeEventListener(type, handler));
  };

  // ---- Rendering ----------------------------------------------------------

  let inputSignature = '';
  let seeking = false;
  let lastVoicedAt = -Infinity;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  function renderInputSelect(state: AppState): void {
    const want = state.input.deviceId ?? (state.input.open ? DEFAULT : NONE);
    inputSelect.replaceChildren(
      option(NONE, 'Choose a microphone…', true),
      option(DEFAULT, 'System default'),
    );
    session.deviceLists.inputs.forEach((d, i) => {
      if (d.deviceId) inputSelect.append(option(d.deviceId, d.label || `Microphone ${i + 1}`));
    });
    const known = [...inputSelect.options].some((o) => o.value === want);
    inputSelect.value = known ? want : NONE;
  }

  function renderOutputSelect(state: AppState): void {
    outputSelect.replaceChildren(option(DEFAULT, 'System default'));
    session.deviceLists.outputs.forEach((d, i) => {
      if (d.deviceId) outputSelect.append(option(d.deviceId, d.label || `Output ${i + 1}`));
    });
    const want = state.output.deviceId ?? DEFAULT;
    const known = [...outputSelect.options].some((o) => o.value === want);
    outputSelect.value = known ? want : DEFAULT;
  }

  function renderMeter(level: number): void {
    meterFill.style.width = `${(meterFraction(level) * 100).toFixed(1)}%`;
    if (level >= METER_CLIP) meterFill.dataset.zone = 'clip';
    else if (level >= METER_HOT) meterFill.dataset.zone = 'hot';
    else delete meterFill.dataset.zone;
    meter.setAttribute('aria-valuenow', level.toFixed(2));
  }

  function renderMonitor(state: AppState): void {
    for (const button of monitorButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.input.monitor));
    }
  }

  function hidePitch(): void {
    pitchReadout.hidden = true;
  }

  function renderPitch(frame: AppState['lastFrame']): void {
    const reading = describePitch(frame);
    clearTimeout(hideTimer);
    if (reading) {
      lastVoicedAt = performance.now();
      pitchReadout.hidden = false;
      setText(pitchNote, reading.note);
      const sign = reading.cents > 0 ? '+' : '';
      setText(pitchCents, `${sign}${reading.cents} c`);
      tunerMarker.style.left = `${reading.cents + 50}%`;
      tunerMarker.dataset.zone = Math.abs(reading.cents) <= TUNER_HIT_CENTS ? 'hit' : 'okay';
      return;
    }
    const wait = PITCH_HOLD_MS - (performance.now() - lastVoicedAt);
    if (wait <= 0) hidePitch();
    else hideTimer = setTimeout(hidePitch, wait);
  }

  function takeRow(take: TakeSummary, number: number, state: AppState): HTMLLIElement {
    const active = take.id === state.playingTakeId;
    const busy = state.recording || state.calibrating;
    const row = document.createElement('li');
    row.className = 'take-item';
    row.dataset.testid = 'take-item';
    row.dataset.takeId = take.id;
    row.dataset.active = String(active);

    const time = new Date(take.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const label = document.createElement('span');
    label.className = 'take-label';
    label.textContent = `Take ${number} · ${formatClock(take.durationS)} · ${time}`;

    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = active ? 'Stop' : 'Play';
    play.disabled = busy;
    play.dataset.testid = 'take-play';
    play.addEventListener('click', () => {
      if (active) session.stopTake();
      else void session.playTake(take.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.disabled = busy;
    del.dataset.testid = 'take-delete';
    let armed: ReturnType<typeof setTimeout> | undefined;
    del.addEventListener('click', () => {
      if (armed === undefined) {
        // Takes cannot be recovered, so the first press only asks.
        del.textContent = 'Sure?';
        armed = setTimeout(() => {
          armed = undefined;
          del.textContent = 'Delete';
        }, DELETE_ARM_MS);
        return;
      }
      clearTimeout(armed);
      void session.deleteTake(take.id);
    });

    row.append(label, play, del);
    return row;
  }

  function render(state: AppState, changed: ReadonlySet<keyof AppState>): void {
    const has = (...keys: Array<keyof AppState>): boolean => keys.some((k) => changed.has(k));

    if (has('song')) {
      setText(songTitle, state.song?.name ?? 'No song loaded');
      songTitle.title = state.song?.name ?? '';
      setText(songDuration, state.song ? formatClock(state.song.durationS) : '');
    }

    // `input` is left out here: its level changes ~20 times a second and none
    // of these controls depend on it.
    if (has('song', 'player', 'recording', 'calibrating', 'tracker', 'loop', 'output')) {
      const song = state.song !== null;
      const busy = state.recording || state.calibrating;
      stopButton.disabled = !song || state.calibrating;
      playButton.disabled = !song || state.calibrating;
      setText(playButton, state.player === 'playing' ? 'Pause' : 'Play');
      recordButton.disabled = !song || state.calibrating || state.tracker === 'unsupported';
      setText(recordButton, state.recording ? 'Stop take' : 'Record');
      recordButton.classList.toggle('is-recording', state.recording);
      recordButton.setAttribute('aria-pressed', String(state.recording));
      loopA.disabled = loopB.disabled = loopToggle.disabled = !song || state.recording;
      loopToggle.setAttribute('aria-pressed', String(state.loop !== null));
      seekInput.disabled = !song;
      calibrateButton.disabled = busy || state.tracker === 'unsupported';
      setText(calibrateButton, state.calibrating ? 'Calibrating…' : 'Calibrate');
      latencyInput.disabled = busy;
      inputSelect.disabled = busy;
      outputSelect.disabled = busy || !state.output.selectable;
      outputSelect.title = state.output.selectable ? '' : 'This browser cannot pick an output device';
      micToggle.disabled = busy;
      // Switching reopens the mic, which would cut the stream a take or a
      // calibration is reading; the Session refuses it too.
      for (const button of monitorButtons) button.disabled = busy;
    }

    if (has('positionS', 'durationS')) {
      const at = seeking ? seekInput.valueAsNumber : state.positionS;
      setText(timeReadout, `${formatClock(at)} / ${formatClock(state.durationS)}`);
      seekInput.max = String(state.durationS);
      if (!seeking) seekInput.value = String(state.positionS);
    }

    if (has('loop')) {
      const { loop } = state;
      setText(loopReadout, loop ? `${formatClock(loop.startS)} to ${formatClock(loop.endS)}` : '');
    }

    if (has('input')) {
      setText(micToggle, state.input.open ? 'Close mic' : 'Open mic');
      renderMeter(state.input.level);
      renderMonitor(state);
      setText(processing, describeMonitor(state.input)?.text ?? '');
      const signature = `${state.input.deviceId}|${state.input.open}|${state.input.label}`;
      if (signature !== inputSignature) {
        inputSignature = signature;
        renderInputSelect(state);
      }
    }

    if (has('output')) renderOutputSelect(state);

    if (has('latencyS') && document.activeElement !== latencyInput) {
      latencyInput.value = state.latencyS === null ? '' : String(Math.round(state.latencyS * 1000));
    }

    if (has('lastFrame')) renderPitch(state.lastFrame);

    if (has('takes', 'playingTakeId', 'recording', 'calibrating')) {
      const { takes } = state;
      takeList.replaceChildren(...takes.map((t, i) => takeRow(t, takes.length - i, state)));
      takeEmpty.hidden = takes.length > 0;
    }

    if (has('status')) {
      setText(statusText, state.status.text);
      statusText.dataset.kind = state.status.kind;
    }
    if (has('input', 'output', 'latencyS', 'tracker', 'framesPerSecond')) {
      setText(statusHealth, describeHealth(state));
    }
  }

  // ---- Controls -----------------------------------------------------------

  const loadFile = (file: File | undefined): void => {
    if (!file) return;
    if (!isAudioFile(file)) store.setStatus(`${file.name} does not look like an audio file.`, 'warn');
    else void session.loadSong(file);
  };

  listen(dropzone, 'click', () => songInput.click());
  listen(dropzone, 'keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    // Stops the page-wide Space shortcut from also toggling playback.
    ev.stopPropagation();
    songInput.click();
  });
  listen(songInput, 'change', () => {
    loadFile(songInput.files?.[0]);
    // Cleared so picking the same file again still counts as a change.
    songInput.value = '';
  });

  // The whole page is a drop target, so a miss never navigates to the file.
  listenDoc('dragover', (ev) => {
    ev.preventDefault();
    dropzone.classList.add('is-over');
  });
  listenDoc('dragleave', (ev) => {
    if (ev.relatedTarget === null) dropzone.classList.remove('is-over');
  });
  listenDoc('drop', (ev) => {
    ev.preventDefault();
    dropzone.classList.remove('is-over');
    loadFile(ev.dataTransfer?.files[0]);
  });

  listen(inputSelect, 'change', () => {
    if (inputSelect.value === NONE) return;
    void session.chooseInput(inputSelect.value === DEFAULT ? null : inputSelect.value);
  });
  listen(outputSelect, 'change', () => {
    void session.chooseOutput(outputSelect.value === DEFAULT ? null : outputSelect.value);
  });
  for (const button of monitorButtons) {
    listen(button, 'click', () => {
      void session.setMonitor(button.dataset.mode === 'speakers' ? 'speakers' : 'headphones');
    });
  }
  listen(refreshButton, 'click', () => void session.refreshDevices());
  listen(micToggle, 'click', () => {
    if (store.state.input.open) void session.closeInput();
    else void session.chooseInput(store.state.input.deviceId);
  });

  listen(calibrateButton, 'click', () => void session.calibrate());
  listen(latencyInput, 'change', () => {
    const text = latencyInput.value.trim();
    session.setLatency(text === '' ? null : Number(text) / 1000);
  });
  clarityInput.value = String(session.settings.clarityThreshold);
  setText(clarityValue, Number(clarityInput.value).toFixed(2));
  listen(clarityInput, 'input', () => {
    session.setClarity(clarityInput.valueAsNumber);
    setText(clarityValue, clarityInput.valueAsNumber.toFixed(2));
  });

  listen(playButton, 'click', () => session.togglePlay());
  listen(stopButton, 'click', () => session.stop());
  listen(recordButton, 'click', () => void session.toggleRecord());
  listen(loopA, 'click', () => session.setLoopPoint('a'));
  listen(loopB, 'click', () => session.setLoopPoint('b'));
  listen(loopToggle, 'click', () => session.toggleLoop());
  listen(seekInput, 'input', () => {
    // Only the readout moves while dragging; the song seeks on release.
    seeking = true;
    setText(timeReadout, `${formatClock(seekInput.valueAsNumber)} / ${formatClock(store.state.durationS)}`);
  });
  listen(seekInput, 'change', () => {
    seeking = false;
    session.seek(seekInput.valueAsNumber);
  });

  // ---- Keyboard -----------------------------------------------------------

  let swallowSpaceUp = false;
  listenDoc('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || usesKeys(ev.target)) return;
    const step = ev.shiftKey ? SEEK_STEP_FINE_S : SEEK_STEP_S;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        // The browser would also click a focused button when Space is released.
        swallowSpaceUp = true;
        if (!ev.repeat) session.togglePlay();
        break;
      case 'r':
      case 'R':
        if (!ev.repeat) void session.toggleRecord();
        break;
      case 'l':
      case 'L':
        if (!ev.repeat) session.toggleLoop();
        break;
      case '[':
        session.setLoopPoint('a');
        break;
      case ']':
        session.setLoopPoint('b');
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        session.nudge(-step);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        session.nudge(step);
        break;
    }
  });
  listenDoc('keyup', (ev) => {
    if (ev.key === ' ' && swallowSpaceUp) {
      swallowSpaceUp = false;
      ev.preventDefault();
    }
  });

  // ---- Start --------------------------------------------------------------

  cleanups.push(store.subscribe(render));
  cleanups.push(
    session.onDevices(() => {
      renderInputSelect(store.state);
      renderOutputSelect(store.state);
    }),
  );
  render(store.state, new Set(Object.keys(store.state) as Array<keyof AppState>));

  return {
    dispose() {
      clearTimeout(hideTimer);
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
