# HACA Office Explorer

A Roblox-style 3D walk-through of the HACA (Haris & Co. Academy) office, built with three.js.
Spawn outside, walk in through the lobby and fingerprint door, and explore every room —
with other players online and proximity voice chat.

## Run it

Requires [Node.js](https://nodejs.org).

```
npm install
npm start
```

or double-click `start-game.bat` on Windows.

- This PC: http://localhost:8080
- Same Wi-Fi: `https://<your-ip>:8443` (printed by the server). The first visit shows a
  certificate warning — click **Advanced → Proceed**. HTTPS is needed for the microphone.

## Controls

| Key | Action |
| --- | --- |
| W A S D | move |
| Shift | run |
| Space | jump |
| Mouse | look (click the game first) |
| Wheel | zoom (all the way in = first person) |
| V | mic on/off (proximity voice) |
| R | respawn |
| Esc | pause |

Touch devices get an on-screen joystick and jump button.

## Files

- `index.html`, `game.js` — the game (three.js from a CDN)
- `server.js` — serves the game, relays player positions and voice-chat signalling (WebSocket), HTTPS for voice
- `paint-hide-seek-office.glb` / `.obj` — the office 3D model
