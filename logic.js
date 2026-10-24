// The rules behind Limit One, kept apart from the page so they can be tested.
// They match the iPhone app: same membership number handling, same duplicate rules.

/** Costco membership numbers are 12 digits. */
export const MEMBER_LENGTH = 12;
/** Anything shorter than this isn't treated as a membership number. */
export const MIN_LENGTH = 6;
/** How long a cleared list can be brought back. After this it's deleted for good. */
export const UNDO_CLEAR_WINDOW = 60 * 60 * 1000;

/**
 * The membership number in a scanned code or typed entry, or null if there isn't a usable one.
 *
 * - A run of exactly 12 digits is the number.
 * - The card barcode is EAN-13, which reads as the 12 digits plus a check digit, so a valid
 *   13-digit EAN-13 loses its last digit.
 * - The digital card in the Costco app is a QR code with a longer run: "96", four more digits,
 *   the 12-digit number, then more digits (seen: 960000 111828995358 000115992157).
 * - Anything else uses its letters and digits as they are, so a code in some other format
 *   still gets a consistent key.
 */
export function normalize(raw) {
  const text = String(raw ?? "");
  const runs = text.split(/[^0-9]+/).filter(Boolean);
  const exact = runs.find((run) => run.length === MEMBER_LENGTH);
  if (exact) return exact;
  const ean = runs.find((run) => run.length === MEMBER_LENGTH + 1 && isValidEAN13(run));
  if (ean) return ean.slice(0, MEMBER_LENGTH);
  const app = runs.find((run) => run.length >= 6 + MEMBER_LENGTH && run.startsWith("96"));
  if (app) return app.slice(6, 6 + MEMBER_LENGTH);
  const cleaned = text.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return cleaned.length >= MIN_LENGTH ? cleaned : null;
}

/** All the digits in a scanned code, kept with the entry when there's more than the number. */
export function codeDigits(raw) {
  return String(raw ?? "").replace(/[^0-9]/g, "");
}

/** Whether the last of 13 digits is the EAN-13 check digit for the first 12. */
function isValidEAN13(digits) {
  const values = [...digits].map(Number);
  const sum = values.slice(0, 12).reduce((total, value, index) => total + value * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === values[12];
}

const copy = (entry) => ({ ...entry, blockedAttempts: [...entry.blockedAttempts] });

/**
 * The members who have bought, saved after every change so closing the page or restarting the
 * device doesn't lose anyone. Times are milliseconds since 1970.
 */
export class PurchaseLog {
  /** Pass `storage` (like localStorage) to keep the list, or null for one only kept in memory. */
  constructor(storage = null, key = "limitone.list", now = Date.now()) {
    this.storage = storage;
    this.key = key;
    /**
     * Oldest first. Each is { number, loggedAt, method: "scanned" | "typed", blockedAttempts: [],
     * code? }, where `code` is the digits of a scanned code that held more than the number.
     */
    this.entries = [];
    this.startedAt = now;
    /** The last list cleared, until it's brought back or the hour is up. */
    this.cleared = null;
    /** Set when the last save failed, cleared by the next one that works. */
    this.saveError = null;
    this.load(now);
  }

  get blockedCount() {
    return this.entries.reduce((total, entry) => total + entry.blockedAttempts.length, 0);
  }

  entry(number) {
    return this.entries.find((entry) => entry.number === number) ?? null;
  }

  /**
   * Checks a number and records the result: adds it if it's new, or logs a blocked attempt if
   * it's already there. Returns { kind: "approved" | "duplicate", entry }.
   */
  check(number, method, now = Date.now(), code = null) {
    this.forgetExpiredClear(now);
    const existing = this.findMember(number, code);
    if (existing) {
      existing.blockedAttempts.push(now);
      this.save();
      return { kind: "duplicate", entry: copy(existing) };
    }
    const entry = { number, loggedAt: now, method, blockedAttempts: [] };
    if (code && code.length > MEMBER_LENGTH) entry.code = code;
    this.entries.push(entry);
    this.save();
    return { kind: "approved", entry: copy(entry) };
  }

  /**
   * The member already on the list: by number, or by a code that contains a listed number (or
   * a listed code that contains this number), in case a QR code is laid out differently from
   * the one `normalize` knows.
   */
  findMember(number, code) {
    const exact = this.entry(number);
    if (exact) return exact;
    return this.entries.find((entry) =>
      (code && entry.number.length === MEMBER_LENGTH && /^[0-9]+$/.test(entry.number) && code.includes(entry.number)) ||
      (entry.code && number.length === MEMBER_LENGTH && entry.code.includes(number))) ?? null;
  }

  remove(number) {
    this.entries = this.entries.filter((entry) => entry.number !== number);
    this.save();
  }

  /** Empties the list once the sale is over. It can be brought back with `undoClear` for an hour. */
  clear(now = Date.now()) {
    if (this.entries.length) {
      this.cleared = { clearedAt: now, startedAt: this.startedAt, entries: this.entries };
    }
    this.entries = [];
    this.startedAt = now;
    this.save();
  }

  /** The list that was cleared, if it can still be brought back. */
  clearedList(now = Date.now()) {
    return this.cleared && now < this.cleared.clearedAt + UNDO_CLEAR_WINDOW ? this.cleared : null;
  }

  /**
   * Brings back the cleared list. Anyone checked since the clear stays on it; if they were
   * already on the old list, that later check counts as a turned-away attempt.
   */
  undoClear(now = Date.now()) {
    const old = this.clearedList(now);
    if (!old) return;
    const merged = old.entries.map(copy);
    for (const entry of this.entries) {
      const match = merged.find((other) => other.number === entry.number);
      if (match) {
        match.blockedAttempts.push(entry.loggedAt, ...entry.blockedAttempts);
      } else {
        merged.push(copy(entry));
      }
    }
    this.entries = merged;
    this.startedAt = old.startedAt;
    this.cleared = null;
    this.save();
  }

  forgetExpiredClear(now) {
    if (this.cleared && now >= this.cleared.clearedAt + UNDO_CLEAR_WINDOW) this.cleared = null;
  }

  load(now) {
    if (!this.storage) return;
    const raw = this.storage.getItem(this.key);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.entries) || typeof saved.startedAt !== "number") throw new Error("Unexpected list format");
      this.entries = saved.entries;
      this.startedAt = saved.startedAt;
      this.cleared = saved.cleared ?? null;
      this.forgetExpiredClear(now);
    } catch {
      // Keep the unreadable copy rather than overwriting it.
      try {
        this.storage.setItem(`${this.key}.unreadable-${now}`, raw);
      } catch {}
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify({ startedAt: this.startedAt, entries: this.entries, cleared: this.cleared }));
      this.saveError = null;
    } catch (error) {
      this.saveError = error?.message || "Storage is full";
    }
  }
}

/**
 * Turns camera reads and typed numbers into checks against the list.
 *
 * A card is checked once per showing: holding it in view doesn't count again, but taking it
 * away and showing it again does. `showing` comes from `Sightings`.
 */
export class ScanModel {
  constructor(log, { settleTime = 1000, inViewTimeout = 800 } = {}) {
    this.log = log;
    /** Right after a check, a new showing of the same card is the camera settling on it. */
    this.settleTime = settleTime;
    /** The last-checked card counts as still in view if the camera saw it this recently. */
    this.inViewTimeout = inViewTimeout;
    /** The full-screen result, while it's up: { id, kind, entry }. */
    this.result = null;
    /** The latest result, kept after the full-screen one closes so staff can glance back or undo. */
    this.lastResult = null;
    this.lastCheck = null;
    this.lastCheckSeenAt = null;
    this.nextID = 1;
  }

  cameraRead(raw, showing, now = Date.now()) {
    const number = normalize(raw);
    if (!number) return;
    const last = this.lastCheck;
    // The same card again is part of the last check if it never left, if the camera is still
    // settling on it, or if its own result is still on screen.
    if (last && last.number === number &&
        (last.showing === showing || now - last.at < this.settleTime || this.result?.entry.number === number)) {
      this.lastCheck = { number, showing, at: last.at };
      this.lastCheckSeenAt = now;
      return;
    }
    // A green result gives way to the next card straight away, to keep the line moving.
    // A red one waits until staff tap it.
    if (this.result && this.result.kind !== "approved") return;
    this.lastCheck = { number, showing, at: now };
    this.lastCheckSeenAt = now;
    this.show(this.log.check(number, "scanned", now, codeDigits(raw)));
  }

  /** Whether the camera is still looking at the card it last checked. */
  isStillInView(number, now = Date.now()) {
    return this.lastCheck?.number === number && this.lastCheckSeenAt !== null && now - this.lastCheckSeenAt < this.inViewTimeout;
  }

  /** Checks a number staff typed in. Returns false if it isn't a usable number. */
  typed(raw, now = Date.now()) {
    const number = normalize(raw);
    if (!number) return false;
    this.show(this.log.check(number, "typed", now));
    return true;
  }

  show(outcome) {
    this.result = { id: this.nextID++, ...outcome };
    this.lastResult = this.result;
  }

  dismissResult() {
    this.result = null;
  }

  /** Takes back the latest approval, for a misread card or someone who changed their mind. */
  undoApproval() {
    if (this.lastResult?.kind !== "approved") return;
    this.log.remove(this.lastResult.entry.number);
    this.result = null;
    this.lastResult = null;
  }
}

/**
 * Works out showings from a stream of reads: the same code read again within `gap` is the
 * same showing; a longer gap means the card left and came back.
 */
export class Sightings {
  constructor(gap = 1200) {
    this.gap = gap;
    this.seen = new Map();
    this.nextID = 1;
  }

  read(value, now = Date.now()) {
    const last = this.seen.get(value);
    const id = last && now - last.at < this.gap ? last.id : this.nextID++;
    this.seen.set(value, { id, at: now });
    return id;
  }
}

const pad = (value) => String(value).padStart(2, "0");

function timestamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The list as CSV, in the same columns as the app's export. */
export function toCSV(entries) {
  const lines = ["Membership number,Bought at,Entered by,Times turned away,Last turned away at"];
  for (const entry of entries) {
    const lastBlocked = entry.blockedAttempts.at(-1);
    lines.push([
      // Written as a formula so Excel keeps all 12 digits instead of showing 1.11E+11.
      `="${entry.number}"`,
      timestamp(entry.loggedAt),
      entry.method === "scanned" ? "Scan" : "Typed",
      String(entry.blockedAttempts.length),
      lastBlocked === undefined ? "" : timestamp(lastBlocked),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

export function csvFilename(startedAt) {
  return `Limit One list ${timestamp(startedAt).slice(0, 10)}.csv`;
}
