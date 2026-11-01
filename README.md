# Always Green

An iPhone web app that tells you what speed to hold to catch the next green light. It learns each light's timing from your own drives and uses only public map data (OpenStreetMap) for light locations and speed limits.

## Install on your iPhone
1. Open the app's link in **Safari**.
2. Tap **Share › Add to Home Screen**. It now opens like a normal app.
3. On first start, allow location access. If you missed the prompt, go to Settings › Privacy & Security › Location Services › Safari Websites and pick "While Using".

## Use it
- Mount the phone. Tap **Start drive** once before you move, then don't touch it. Michigan law allows a single touch while driving.
- Keep the app open with the screen on. It holds the screen awake, but iPhone pauses location for web apps in the background.
- Drive normally. Every light you **stop at** teaches the app when it turns green. Lights you pass on green help confirm the timing.
- The map in the middle shows you (blue) and the lights ahead: grey = learning, amber = guess, green = likely/sure. Map tiles © OpenStreetMap contributors.
- Labels: **Learning** (no data yet), **Guess** (1–2 stops), **Likely** (3+ stops), **Sure** (about 6+ consistent stops in the same time-of-day plan).
- Take the same route at similar times of day. Lights often switch timing plans for morning rush, midday, evening rush and weekends, and the app learns each one separately.

## Safety rules built in
- Never advises above the speed limit. Where the limit isn't in the map data, it only advises slowing down (change this in Settings).
- Never advises below 60% of the limit. It says "Ease off" when a red can't be avoided.
- Advice only. Always obey the actual light and traffic.

## What works well, and what doesn't
- Works for **fixed-time** lights, the kind that run the same cycle on a clock. Many arterial corridors do.
- Lights that react to sensors, pedestrian buttons or bus priority change their timing on the fly. The app learns that they're unpredictable and stays quiet there.
- In simulation, after learning, it cut stops by about half. Real-world savings will be smaller, around 5% fuel in published pilots.

## Your data
Everything stays on your phone (browser storage). Use **Back up data** regularly; clearing Safari's website data erases what it learned.

## Updating
The version number is at the bottom of the home screen and next to the app name while driving. After uploading new files, close the app fully (swipe it away) and reopen it.

## Files
`index.html` (screens) · `app.js` (GPS, map data, voice) · `core.js` (timing learner and speed advisor) · `sw.js` (offline cache) · `manifest.webmanifest`, icons.
