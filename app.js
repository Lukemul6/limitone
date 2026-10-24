import { MEMBER_LENGTH, MIN_LENGTH, PurchaseLog, ScanModel, Sightings, toCSV, csvFilename } from "./logic.js";

const $ = (id) => document.getElementById(id);

// `?demo` shows sample data kept only in memory, for checking the layout without a camera.
const demo = new URLSearchParams(location.search).get("demo");
const log = demo === null ? new PurchaseLog(localStorage, "limitone.list") : demoLog();

function demoLog() {
  const start = new Date().setHours(9, 2, 0, 0);
  const sample = new PurchaseLog(null, "demo", start);
  ["111284730192", "111093827465", "800117264538", "111562039481", "111748201936", "800293847102", "111330918274"]
    .forEach((number, i) => sample.check(number, i === 3 ? "typed" : "scanned", start + i * 140_000 + 30_000));
  sample.check("111093827465", "scanned", start + 1_500_000);
  return sample;
}
// Browser decoding misses some frames even while a card is held still, so a showing only ends
// after the code hasn't been read for a while.
const SHOWING_GAP = 1200;
const model = new ScanModel(log, { settleTime: 1000, inViewTimeout: SHOWING_GAP });
const sightings = new Sightings(SHOWING_GAP);
/** A green result closes itself after this long; the next card can replace it sooner. */
const APPROVED_DURATION = 1200;
/** A red result can be closed by tapping anywhere, but not in the first moment. */
const RED_TAP_DELAY = 600;

let soundOn = localStorage.getItem("limitone.sound") !== "off";

// MARK: - Formatting

const time = new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit" });
const dayAndTime = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const longDate = new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" });
const relativeTime = new Intl.RelativeTimeFormat("en-CA", { numeric: "auto" });

const isToday = (ms) => new Date(ms).toDateString() === new Date().toDateString();
/** "9:15 a.m." for today, "Oct. 23, 9:15 a.m." for any other day. */
const timeOrDayAndTime = (ms) => (isToday(ms) ? time.format(ms) : dayAndTime.format(ms));
const members = (count) => (count === 1 ? "1 member" : `${count.toLocaleString("en-CA")} members`);

function ago(ms) {
  const seconds = Math.round((ms - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relativeTime.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}

const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ICONS = {
  check: '<svg class="big-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-7"/></svg>',
  octagon: '<svg class="big-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  smallCheck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>',
  smallX: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};

// MARK: - Rendering

function render() {
  const count = log.entries.length;
  $("bought-count").textContent = count.toLocaleString("en-CA");
  $("bought-label").textContent = count === 1 ? "member bought" : "members bought";
  $("blocked-stat").hidden = log.blockedCount === 0;
  $("blocked-count").textContent = log.blockedCount.toLocaleString("en-CA");
  renderNotices();
  renderResult();
  renderLastResult();
  if ($("list-sheet").open) renderList();
}

function renderNotices() {
  const notices = [];
  if (log.saveError) {
    notices.push({ text: `Couldn't save the list: ${log.saveError}`, tint: "red" });
  }
  const cleared = log.clearedList();
  if (cleared) {
    notices.push({ text: `List cleared at ${time.format(cleared.clearedAt)}. Cleared by mistake? Tap to bring it back.`, tint: "gray", opensList: true });
  }
  if (!isToday(log.startedAt) && log.entries.length) {
    notices.push({ text: `This list started ${longDate.format(log.startedAt)}. If this is a new sale, clear it from the list.`, tint: "orange", opensList: true });
  }
  const container = $("notices");
  container.replaceChildren(...notices.map((notice) => {
    const element = document.createElement(notice.opensList ? "button" : "div");
    element.className = `notice ${notice.tint}`;
    element.textContent = notice.text;
    if (notice.opensList) element.addEventListener("click", openList);
    return element;
  }));
}

let shownResultID = null;
let approvedTimer = null;
let redTapReadyAt = 0;

function renderResult() {
  const result = model.result;
  const element = $("result");
  if (!result) {
    element.hidden = true;
    shownResultID = null;
    clearTimeout(approvedTimer);
    return;
  }
  if (result.id === shownResultID) return;
  shownResultID = result.id;
  clearTimeout(approvedTimer);
  element.hidden = false;
  const entry = result.entry;
  if (result.kind === "approved") {
    element.className = "result approved";
    element.innerHTML = `
      ${ICONS.check}
      <h2>APPROVED</h2>
      <p>First purchase. Added to the list.</p>
      <div class="number">${escapeHTML(entry.number)}</div>`;
    approvedTimer = setTimeout(() => {
      if (model.result?.id === result.id) {
        model.dismissResult();
        render();
      }
    }, APPROVED_DURATION);
  } else {
    element.className = "result duplicate";
    const bought = isToday(entry.loggedAt) ? `Already bought at ${time.format(entry.loggedAt)}` : `Already bought ${dayAndTime.format(entry.loggedAt)}`;
    const times = entry.blockedAttempts.length;
    element.innerHTML = `
      <div class="spacer"></div>
      ${ICONS.octagon}
      <h2>DUPLICATE<br>PURCHASE</h2>
      <div><p>${escapeHTML(bought)}</p><p class="dim">${escapeHTML(ago(entry.loggedAt))}</p></div>
      <div class="number">${escapeHTML(entry.number)}</div>
      ${times > 1 ? `<span class="times">Turned away ${times} times</span>` : ""}
      <div class="spacer"></div>
      <button class="next" type="button">Next member</button>`;
    redTapReadyAt = Date.now() + RED_TAP_DELAY;
  }
  playFeedback(result);
}

$("result").addEventListener("click", (event) => {
  const result = model.result;
  if (!result) return;
  if (result.kind === "duplicate" && !event.target.closest(".next") && Date.now() < redTapReadyAt) return;
  model.dismissResult();
  render();
});

/** The latest result after its full-screen flash, until the next one. */
function renderLastResult() {
  const bar = $("last-result");
  const last = model.lastResult;
  const entry = last && log.entry(last.entry.number);
  if (model.result || !entry) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const approved = last.kind === "approved";
  const icon = $("last-icon");
  icon.className = `last-icon ${approved ? "approved" : "duplicate"}`;
  icon.innerHTML = approved ? ICONS.smallCheck : ICONS.smallX;
  $("last-number").textContent = entry.number;
  const detail = $("last-detail");
  if (model.isStillInView(entry.number)) {
    detail.textContent = "Still in view. Move the card away to scan it again.";
    detail.className = "last-detail orange";
  } else {
    detail.textContent = approved ? `Approved at ${timeOrDayAndTime(entry.loggedAt)}` : `Duplicate. Bought at ${timeOrDayAndTime(entry.loggedAt)}`;
    detail.className = "last-detail";
  }
  $("last-undo").hidden = !approved;
}

$("last-undo").addEventListener("click", () => {
  model.undoApproval();
  render();
});

// Keeps the "still in view" hint and the times current.
setInterval(renderLastResult, 500);

// MARK: - Sound

let audio = null;

function unlockAudio() {
  try {
    // Play through the ring/silent switch, like the app does.
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    audio ??= new AudioContext();
    audio.resume();
  } catch {}
}

/** `notes` are [frequency in Hz, seconds]; a frequency of 0 is a rest. */
function playTone(notes, type) {
  if (!audio || !soundOn) return;
  let at = audio.currentTime + 0.01;
  const level = type === "square" ? 0.22 : 0.5;
  for (const [frequency, seconds] of notes) {
    if (frequency > 0) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      // Fade each note in and out so it doesn't click.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(level, at + 0.005);
      gain.gain.setValueAtTime(level, at + seconds - 0.005);
      gain.gain.linearRampToValueAtTime(0, at + seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + seconds);
    }
    at += seconds;
  }
}

function playFeedback(result) {
  if (result.kind === "approved") {
    playTone([[1047, 0.09], [0, 0.03], [1568, 0.16]], "sine");
    navigator.vibrate?.(60);
  } else {
    playTone([[466, 0.22], [0, 0.07], [466, 0.22], [0, 0.07], [466, 0.4]], "square");
    navigator.vibrate?.([200, 100, 200, 100, 400]);
  }
}

function renderSound() {
  $("sound-on").hidden = !soundOn;
  $("sound-off").hidden = soundOn;
  $("sound").setAttribute("aria-label", soundOn ? "Turn off sound" : "Turn on sound");
}

$("sound").addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem("limitone.sound", soundOn ? "on" : "off");
  unlockAudio();
  renderSound();
});

// MARK: - Camera and scanning

const video = $("camera");
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const readerOptions = { formats: ["EAN13", "QRCode", "Code128"], tryHarder: true, maxNumberOfSymbols: 1 };
/** Frames are scaled down to this before decoding, which keeps each read quick. */
const MAX_DECODE_SIDE = 1100;

let stream = null;
let track = null;
let torchOn = false;
let scanning = false;

ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith(".wasm") ? new URL("vendor/zxing_reader.wasm", location.href).href : prefix + path),
  },
  fireImmediately: true,
}).catch((error) => showCameraMessage("Scanner didn't load", `Reload the page. (${error.message})`));

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (error) {
    if (error.name === "NotAllowedError") {
      showCameraMessage("Camera access is off", "Allow the camera for this site in Safari (aA button in the address bar, then Website Settings). You can still type numbers in.");
    } else {
      showCameraMessage("No camera found", "Type membership numbers in instead.");
    }
    return;
  }
  $("camera-message").hidden = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities?.() ?? {};
  $("torch").hidden = !capabilities.torch;
  if (capabilities.focusMode?.includes("continuous")) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }
  if (torchOn) setTorch(true);
  if (!scanning) scanLoop();
}

function showCameraMessage(title, detail) {
  const message = $("camera-message");
  message.innerHTML = `<h2>${escapeHTML(title)}</h2><p>${escapeHTML(detail)}</p>`;
  message.hidden = false;
}

/** The part of the video frame under the scan frame, with a little slack, in video pixels. */
function readRegion() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const view = video.getBoundingClientRect();
  const frame = $("frame").getBoundingClientRect();
  // The video fills the screen (object-fit: cover), so work out the scale and cropped edges.
  const scale = Math.max(view.width / width, view.height / height);
  const offsetX = (view.width - width * scale) / 2;
  const offsetY = (view.height - height * scale) / 2;
  const slack = 24;
  const left = Math.max(0, (frame.left - view.left - slack - offsetX) / scale);
  const top = Math.max(0, (frame.top - view.top - slack - offsetY) / scale);
  const right = Math.min(width, (frame.right - view.left + slack - offsetX) / scale);
  const bottom = Math.min(height, (frame.bottom - view.top + slack - offsetY) / scale);
  if (right <= left || bottom <= top) return null;
  const shrink = Math.min(1, MAX_DECODE_SIDE / Math.max(right - left, bottom - top));
  return {
    sx: left, sy: top, sw: right - left, sh: bottom - top,
    w: Math.round((right - left) * shrink), h: Math.round((bottom - top) * shrink),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sheetOpen = () => $("list-sheet").open || $("entry-sheet").open;

async function scanLoop() {
  scanning = true;
  while (scanning) {
    const started = performance.now();
    const region = !document.hidden && video.readyState >= 2 ? readRegion() : null;
    if (region) {
      canvas.width = region.w;
      canvas.height = region.h;
      context.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.w, region.h);
      try {
        const results = await ZXingWASM.readBarcodes(context.getImageData(0, 0, region.w, region.h), readerOptions);
        const now = Date.now();
        const before = model.result?.id;
        for (const result of results) {
          if (!result.isValid || !result.text) continue;
          const showing = sightings.read(result.text, now);
          // Don't check cards behind the list or the keypad.
          if (!sheetOpen()) model.cameraRead(result.text, showing, now);
        }
        if (model.result?.id !== before) render();
      } catch (error) {
        console.error(error);
      }
    }
    await sleep(Math.max(10, 60 - (performance.now() - started)));
  }
}

function setTorch(on) {
  torchOn = on;
  $("torch").setAttribute("aria-label", on ? "Turn off light" : "Turn on light");
  track?.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
}

$("torch").addEventListener("click", () => setTorch(!torchOn));

// MARK: - Keeping the screen on and the camera going

let wakeLock = null;

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !$("start").hidden) return;
  keepAwake();
  // Safari can stop the camera while the page is in the background.
  if (!track || track.readyState === "ended") startCamera();
  render();
});

$("start-button").addEventListener("click", () => {
  unlockAudio();
  keepAwake();
  $("start").hidden = true;
  startCamera();
});

// MARK: - Typing a number in

const entryInput = $("entry-input");

function renderEntryHint() {
  const digits = entryInput.value;
  const hint = $("entry-hint");
  $("entry-check").disabled = digits.length < MIN_LENGTH;
  if (digits.length === 0 || digits.length === MEMBER_LENGTH) {
    hint.textContent = `${digits.length} of ${MEMBER_LENGTH} digits`;
    hint.className = "entry-hint";
  } else {
    hint.textContent = `${digits.length} of ${MEMBER_LENGTH} digits. Check it against the card.`;
    hint.className = "entry-hint warn";
  }
}

entryInput.addEventListener("input", () => {
  const digits = entryInput.value.replace(/\D/g, "").slice(0, 20);
  if (digits !== entryInput.value) entryInput.value = digits;
  renderEntryHint();
});

$("type-number").addEventListener("click", () => {
  unlockAudio();
  entryInput.value = "";
  renderEntryHint();
  $("entry-sheet").showModal();
  entryInput.focus();
});

$("entry-sheet").addEventListener("close", () => {
  if ($("entry-sheet").returnValue === "check" && entryInput.value.length >= MIN_LENGTH) {
    model.typed(entryInput.value);
  }
  $("entry-sheet").returnValue = "";
  render();
});

// MARK: - The list

function openList() {
  $("search").value = "";
  renderList();
  $("list-sheet").showModal();
  // Opening a dialog focuses its first button; don't leave Export looking selected.
  document.activeElement?.blur();
}

$("open-list").addEventListener("click", openList);
$("close-list").addEventListener("click", () => $("list-sheet").close());
$("list-sheet").addEventListener("close", render);
$("search").addEventListener("input", renderList);

function renderList() {
  $("sum-members").textContent = log.entries.length.toLocaleString("en-CA");
  $("sum-blocked").textContent = log.blockedCount.toLocaleString("en-CA");
  $("sum-started").textContent = dayAndTime.format(log.startedAt);
  $("export").disabled = log.entries.length === 0;

  const cleared = log.clearedList();
  const undo = $("undo-clear");
  undo.hidden = !cleared;
  if (cleared) undo.textContent = `Bring back ${members(cleared.entries.length)}`;
  const clear = $("clear-list");
  clear.hidden = Boolean(cleared) && log.entries.length === 0;
  clear.disabled = log.entries.length === 0;
  $("clear-note").textContent = cleared
    ? `The list was cleared at ${time.format(cleared.clearedAt)}. If that was a mistake, you can bring it back until ${time.format(cleared.clearedAt + 60 * 60 * 1000)}.`
    : "Removes every number from this device so the next sale starts fresh. You can undo it for an hour.";

  const query = $("search").value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const shown = [...log.entries].reverse().filter((entry) => !query || entry.number.includes(query));
  const list = $("entries");
  list.hidden = shown.length === 0;
  list.replaceChildren(...shown.map((entry) => {
    const row = document.createElement("div");
    row.className = "entry";
    const blocked = entry.blockedAttempts.length;
    row.innerHTML = `
      <div class="entry-main">
        <div class="entry-number">${escapeHTML(entry.number)}</div>
        <div class="entry-detail">${escapeHTML(timeOrDayAndTime(entry.loggedAt))}, ${entry.method === "scanned" ? "scanned" : "typed"}</div>
      </div>
      ${blocked ? `<span class="entry-blocked" aria-label="Turned away ${blocked} times">&#x2715; ${blocked}</span>` : ""}
      <button class="entry-remove" type="button">Remove</button>`;
    row.querySelector(".entry-remove").addEventListener("click", async () => {
      if (await confirmAction(`Remove ${entry.number}?`, "They'll be able to buy again.", "Remove")) {
        log.remove(entry.number);
        render();
      }
    });
    return row;
  }));
  const empty = $("entries-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = log.entries.length ? `No match for "${$("search").value}"` : "No one yet. Members show up here as they're checked.";
}

$("clear-list").addEventListener("click", async () => {
  const count = log.entries.length;
  const message = "Only do this once the sale is sold out. Everyone on the list will be able to buy again.\n\nYou can undo it from this screen for an hour. Export the list first if your manager needs a record.";
  if (await confirmAction(`Clear all ${members(count)}?`, message, "Clear list")) {
    log.clear();
    render();
  }
});

$("undo-clear").addEventListener("click", () => {
  log.undoClear();
  render();
});

$("export").addEventListener("click", async () => {
  const file = new File([toCSV(log.entries)], csvFilename(log.startedAt), { type: "text/csv" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Purchase list" });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

/** A centred confirmation with Cancel as the safe default. Resolves true if confirmed. */
function confirmAction(title, message, confirmLabel) {
  const dialog = $("confirm-sheet");
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = confirmLabel;
  return new Promise((resolve) => {
    const finish = (confirmed) => {
      $("confirm-ok").onclick = null;
      $("confirm-cancel").onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(confirmed);
    };
    $("confirm-ok").onclick = () => finish(true);
    $("confirm-cancel").onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.showModal();
    $("confirm-cancel").focus();
  });
}

// MARK: - Start

renderSound();
if (demo !== null) {
  $("start").hidden = true;
  showCameraMessage("Demo", "Sample data only. Nothing here is saved.");
  if (demo === "duplicate") model.typed("111093827465");
  if (demo === "approved") model.typed("111905562830");
  if (demo === "bar") { model.typed("111905562830"); model.dismissResult(); }
}
render();
if (demo === "list") openList();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
