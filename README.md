# Limit One (web)

The web version of the Limit One iPhone app: one purchase per member. It runs in Safari from a link, so it works on any iPad or phone without installing anything or registering the device.

**Link:** https://lukemul6.github.io/limitone/

## Setting up a device

1. Open the link in Safari.
2. Tap the Share button, then **Add to Home Screen**. It then opens full screen like an app, and Safari keeps its list safe. (A list kept in a normal Safari tab can be deleted by Safari if the site isn't opened for a week.)
3. Open it, tap **Start scanning** and allow the camera.

Once it has loaded it keeps working without a connection.

## How it works

The same as the iPhone app: scan or type a membership number, green **Approved** for a first purchase, flashing red **Duplicate purchase** with the time they bought if they're already on the list. The list, search, export, **Sold out? Clear the list** (with a confirmation, and an hour to bring it back) and Undo work the same way.

- On an iPad (or any screen at least 700 points wide) the camera sits on the left and a sidebar on the right shows the counts, the last result, the controls and everyone on the list. Typing a number uses a large on-screen number pad. Phones keep the full-screen camera layout. Both work in either orientation; on a phone turned sideways the sidebar scrolls and the keypad sits beside the number.
- The list is saved in this browser on this device only. Each device has its own list.
- Nothing is sent anywhere. The page only loads its own files.
- Barcodes are read with [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.6 (MIT, in `vendor/`), from the area inside the frame only.
- Costco cards are EAN-13: the 12-digit membership number plus a check digit, which is dropped (`normalize` in `logic.js`).

## Development

```bash
npm test                                  # logic tests (Node)
python3 -m http.server 8765               # then open http://127.0.0.1:8765/
```

`?demo`, `?demo=list`, `?demo=entry`, `?demo=approved`, `?demo=duplicate` or `?demo=bar` show sample data kept only in memory, for checking the layout without a camera.

Publishing: push to `main`; GitHub Pages serves the repo root. After changing any file, bump `CACHE` in `sw.js` so devices pick up the new version.
