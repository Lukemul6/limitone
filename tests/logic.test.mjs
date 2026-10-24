import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, codeDigits, PurchaseLog, ScanModel, Sightings, toCSV, csvFilename, UNDO_CLEAR_WINDOW } from "../logic.js";

const start = 1_793_000_000_000;
const at = (seconds) => start + seconds * 1000;
const card = "111234567890";
const other = "800117264538";

class MemoryStorage {
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, String(value)); }
}

// Membership numbers

test("keeps a plain number and drops spaces and dashes", () => {
  assert.equal(normalize("111234567890"), "111234567890");
  assert.equal(normalize(" 1112 3456-7890 "), "111234567890");
});

test("reads the card barcode: 12 digits plus an EAN-13 check digit", () => {
  // A real card: "Mbr# 111828995358" printed, EAN-13 "1118289953586" in the barcode.
  assert.equal(normalize("1118289953586"), "111828995358");
});

test("reads the number out of the app's QR code", () => {
  // The same member's digital card in the Costco app.
  assert.equal(normalize("960000111828995358000115992157"), "111828995358");
});

test("keeps a 13-digit code that isn't an EAN-13", () => {
  assert.equal(normalize("1118289953581"), "1118289953581");
});

test("finds the number inside other data, falls back to the whole code, rejects short ones", () => {
  assert.equal(normalize("M:111234567890;EXP:20271031"), "111234567890");
  assert.equal(normalize("ab-1234-cd"), "AB1234CD");
  assert.equal(normalize("12345"), null);
  assert.equal(normalize("   "), null);
});

// The list

test("first check approves, second is a duplicate with the attempt recorded", () => {
  const log = new PurchaseLog(null, "k", start);
  assert.equal(log.check(card, "scanned", start).kind, "approved");
  const second = log.check(card, "typed", at(600));
  assert.equal(second.kind, "duplicate");
  assert.equal(second.entry.loggedAt, start);
  assert.deepEqual(second.entry.blockedAttempts, [at(600)]);
  assert.equal(log.entries.length, 1);
  assert.equal(log.blockedCount, 1);
});

test("card and app QR code are the same member, in either order", () => {
  const qr = "960000111828995358000115992157";
  const cardFirst = new PurchaseLog(null, "k", start);
  cardFirst.check(normalize("1118289953586"), "scanned", start, codeDigits("1118289953586"));
  assert.equal(cardFirst.check(normalize(qr), "scanned", at(60), codeDigits(qr)).kind, "duplicate");

  const qrFirst = new PurchaseLog(null, "k", start);
  qrFirst.check(normalize(qr), "scanned", start, codeDigits(qr));
  assert.equal(qrFirst.check(normalize("1118289953586"), "scanned", at(60), codeDigits("1118289953586")).kind, "duplicate");
  assert.equal(qrFirst.entries.length, 1);
});

test("a code in a layout it doesn't know still matches a listed number inside it", () => {
  const odd = "7700111828995358999";
  const log = new PurchaseLog(null, "k", start);
  log.check("111828995358", "scanned", start);
  assert.equal(log.check(normalize(odd), "scanned", at(60), codeDigits(odd)).kind, "duplicate");

  const reverse = new PurchaseLog(null, "k", start);
  reverse.check(normalize(odd), "scanned", start, codeDigits(odd));
  assert.equal(reverse.check("111828995358", "typed", at(60)).kind, "duplicate");
});

test("a removed member can buy again", () => {
  const log = new PurchaseLog(null, "k", start);
  log.check(card, "scanned", start);
  log.remove(card);
  assert.equal(log.check(card, "scanned", at(1)).kind, "approved");
});

test("clearing can be undone for an hour, keeping anyone checked since", () => {
  const log = new PurchaseLog(null, "k", start);
  log.check(card, "scanned", start);
  log.clear(at(600));
  assert.equal(log.entries.length, 0);
  log.check(card, "scanned", at(660));
  log.check(other, "scanned", at(690));
  log.undoClear(at(720));
  assert.deepEqual(log.entries.map((e) => e.number), [card, other]);
  assert.equal(log.entries[0].loggedAt, start);
  assert.deepEqual(log.entries[0].blockedAttempts, [at(660)]);
  assert.equal(log.startedAt, start);
});

test("undo runs out after an hour", () => {
  const log = new PurchaseLog(null, "k", start);
  log.check(card, "scanned", start);
  log.clear(start);
  const late = start + UNDO_CLEAR_WINDOW + 1;
  assert.equal(log.clearedList(late), null);
  log.undoClear(late);
  assert.equal(log.entries.length, 0);
});

test("the list survives a reload, and the cleared one is gone once the hour is up", () => {
  const storage = new MemoryStorage();
  const log = new PurchaseLog(storage, "k", start);
  log.check(card, "scanned", start);
  log.check(card, "scanned", at(30));
  assert.deepEqual(new PurchaseLog(storage, "k", at(60)).entries, log.entries);

  log.clear(at(100));
  const late = at(100) + UNDO_CLEAR_WINDOW + 1;
  const reopened = new PurchaseLog(storage, "k", late);
  reopened.check(other, "scanned", late);
  assert.ok(!storage.getItem("k").includes(card));
});

test("an unreadable saved list is kept aside, not lost", () => {
  const storage = new MemoryStorage();
  storage.setItem("k", "not json");
  const log = new PurchaseLog(storage, "k", start);
  assert.equal(log.entries.length, 0);
  assert.equal(storage.getItem(`k.unreadable-${start}`), "not json");
});

// Scanning

const makeModel = () => new ScanModel(new PurchaseLog(null, "k", start));

test("a card held in view is only checked once", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  assert.equal(model.result.kind, "approved");
  model.dismissResult();
  for (let tick = 1; tick <= 200; tick++) model.cameraRead(card, 1, at(tick * 0.1));
  assert.equal(model.result, null);
  assert.equal(model.log.blockedCount, 0);
});

test("the same card shown again comes up red, even right away", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  for (let tick = 1; tick <= 10; tick++) model.cameraRead(card, 1, at(tick * 0.3));
  model.dismissResult();
  model.cameraRead(card, 2, at(3.5));
  assert.equal(model.result.kind, "duplicate");
});

test("the camera settling on a card isn't a duplicate", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  model.cameraRead(card, 2, at(0.4));
  assert.equal(model.result.kind, "approved");
  model.dismissResult();
  model.cameraRead(card, 2, at(5));
  assert.equal(model.result, null);
});

test("showing the card again while its red is up doesn't count again", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  model.dismissResult();
  model.cameraRead(card, 2, at(10));
  assert.equal(model.result.kind, "duplicate");
  model.cameraRead(card, 3, at(13));
  model.dismissResult();
  model.cameraRead(card, 3, at(14));
  assert.equal(model.result, null);
  assert.equal(model.log.blockedCount, 1);
});

test("knows when the last card is still in view", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  model.cameraRead(card, 1, at(4));
  assert.ok(model.isStillInView(card, at(4.2)));
  assert.ok(!model.isStillInView(card, at(5)));
  assert.ok(!model.isStillInView(other, at(4.2)));
});

test("the next card replaces a green result", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  model.cameraRead(other, 2, at(0.5));
  assert.equal(model.result.entry.number, other);
  assert.equal(model.log.entries.length, 2);
});

test("other cards wait while a red result is up", () => {
  const model = makeModel();
  model.typed(card, start);
  model.dismissResult();
  model.cameraRead(card, 1, at(10));
  assert.equal(model.result.kind, "duplicate");
  model.cameraRead(other, 2, at(11));
  assert.equal(model.result.entry.number, card);
  model.dismissResult();
  model.cameraRead(other, 2, at(11.3));
  assert.equal(model.result.entry.number, other);
});

test("undo takes back the latest approval, even after the green closes, but not a duplicate", () => {
  const model = makeModel();
  model.cameraRead(card, 1, start);
  model.dismissResult();
  model.undoApproval();
  assert.equal(model.log.entries.length, 0);
  assert.equal(model.lastResult, null);

  model.typed(card, at(1));
  model.dismissResult();
  model.typed(card, at(2));
  model.undoApproval();
  assert.equal(model.result.kind, "duplicate");
  assert.equal(model.log.entries.length, 1);
});

test("a scanned card matches the typed number", () => {
  const model = makeModel();
  model.cameraRead("1118289953586", 1, start);
  assert.equal(model.result.entry.number, "111828995358");
  model.dismissResult();
  model.typed("111828995358", at(60));
  assert.equal(model.result.kind, "duplicate");
});

test("unusable reads are ignored", () => {
  const model = makeModel();
  model.cameraRead("123", 1, start);
  assert.equal(model.result, null);
  assert.equal(model.typed("12", start), false);
});

test("sightings: steady reads are one showing, a gap starts a new one", () => {
  const sightings = new Sightings(1200);
  const first = sightings.read(card, start);
  assert.equal(sightings.read(card, at(0.5)), first);
  assert.equal(sightings.read(card, at(1.5)), first);
  assert.notEqual(sightings.read(card, at(3)), first);
  assert.notEqual(sightings.read(other, at(3)), first);
});

// Export

test("CSV has one row per member, numbers kept whole for Excel", () => {
  const bought = new Date(2026, 9, 24, 9, 5, 7).getTime();
  const csv = toCSV([
    { number: "111234567890", loggedAt: bought, method: "scanned", blockedAttempts: [bought + 60_000, bought + 3_600_000] },
    { number: "800117264538", loggedAt: bought, method: "typed", blockedAttempts: [] },
  ]);
  assert.equal(csv, [
    "Membership number,Bought at,Entered by,Times turned away,Last turned away at",
    '="111234567890",2026-10-24 09:05:07,Scan,2,2026-10-24 10:05:07',
    '="800117264538",2026-10-24 09:05:07,Typed,0,',
    "",
  ].join("\n"));
  assert.equal(csvFilename(bought), "Limit One list 2026-10-24.csv");
});
