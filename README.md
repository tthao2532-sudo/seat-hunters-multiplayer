# SEAT HUNTERS! — Real-time multiplayer

A 60-second, five-station Taipei MRT seat hunting game for 2–40 players in the same room.

## How to run locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Open http://localhost:3000.

## Deploy to Render

1. Upload `server.js`, `package.json`, and the `public` folder to the root of a GitHub repository.
2. On Render, choose **New → Web Service** and connect that repository.
3. Select **Node**, build command `npm install`, start command `npm start`, and choose a suitable instance.
4. Share the resulting HTTPS URL. One person creates a room; everyone else joins by invite link or six-digit code.

**Important:** This app uses an in-memory room store. Run a single server instance. Restarting the service resets rooms; free Render instances may sleep when idle. Test with your class before presentation. For persistent sessions or multiple server instances, add a shared store such as Redis.

## Game rules

Five rounds of 12 seconds each: 5s predict, 2s reveal, 4s seat rush, 1s results. Three random passengers leave at each station. The earliest correct prediction wins the Lucky Seat (+10 correct and +20 seat). Other correct predictions earn +10. Two free seats (+20 each) go to the first valid server-received claims. If nobody predicts correctly, all three seats are free.
