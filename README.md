# 🎌 Anime Quest 5: live team quiz with zero build step

A real-time multiplayer quiz for up to **30 players in 10 teams**. The host runs 10 themed rounds from a control panel, players answer from their phones, and everyone's timer stays in sync.

Written in plain JavaScript with no frameworks and no build tools: the whole app is a static site served straight from GitHub Pages, with Firebase Realtime Database as the backend.

**[▶ Play (player screen)](https://gigantic536wall.github.io/animekvest5/)** · [Host panel](https://gigantic536wall.github.io/animekvest5/admin.html) · [Русская версия](README.ru.md)

> Looking for the bigger version with React, TypeScript, Firebase Auth and tested security rules? See **[Anime Quest 4](https://github.com/gigantic536wall/anime-quest)**.

<!-- TODO: screenshots / GIF: player lobby, question, scoreboard, host panel -->

## Features

- **10 round types, 93 questions**: spot the mistake, odd one out, put in order, true/false, anagrams, a "famous frame" revealed in 4 stages, a final round with bets, and more
- **Server-synced timers**: every timer is calculated from Firebase server time, so all players see the same countdown regardless of their device clock
- **Automatic game flow**: question → pause → next question, with pause, skip and freeze controls for the host
- **One answer per team**: the database accepts only the first answer from a team (conditional write with ETag), so simultaneous answers never overwrite each other
- **Overflow protection**: optimistic transactions make sure a team never gets more than 3 players, even when people join at the same moment
- **Mixed checking**: some rounds are scored automatically, the rest go to a review panel with ✓/✗ buttons
- **Scoreboard with podium**, team avatars, color-coded answers, team renaming in the lobby
- **Answer reveal mode**: after a round, the host and players flip through the correct answers together

## Tech stack

- **Frontend:** HTML, CSS, vanilla JavaScript
- **Backend:** Firebase Realtime Database through its REST API and Server-Sent Events (no SDK)
- **Hosting:** GitHub Pages

## How it works

```
index.html      player screen
admin.html      host control panel
questions.json  all rounds and questions
media/          images for rounds 7 and 9
js/common.js    database client (REST + EventSource), server time sync, scoring
js/player.js    player screen logic
js/admin.js     host logic and game engine
css/style.css   styles
```

The host's browser drives the game: it moves the shared state (`phase`, `round`, `q`, `start`) forward on a timer, and every client renders from that state in real time.

## Run locally

No install needed. Serve the folder with any static server:

```bash
npx serve .
```

To use your own database, change the database URL in `js/common.js`. To change the host password, replace `ADMIN_HASH` in `js/admin.js` with the SHA-256 hash of the new password.

## Known limitations

This version was built for quick games with friends, so it trades security for simplicity: the database is open, the host password is checked in the browser, and the answers are in the public `questions.json`. All of these are fixed in [Anime Quest 4](https://github.com/gigantic536wall/anime-quest) with Firebase Authentication, security rules and a private answers branch.
