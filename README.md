# Community IPTV Player

## Manifesto

The goal of this repository is not only to deliver an IPTV player, but also to demonstrate a broader point about software development:

- useful applications can be written entirely by AI,
- they can be released as free and open source software,
- and they can compete with paid applications that provide less value to users.

In that sense, this project is both a product and a public example of what AI-assisted software creation can make possible at open source scale.

## Why It Matters

Many consumer applications charge for functionality that should be standard, rely on advertisements to support basic use, or create artificial limitations to push users into paid upgrades. In many cases, those products are not meaningfully better engineered or more capable than what can be built and shared freely.

This repository takes a different position. Software can be free, open, useful, and technically credible without being reduced to a funnel for subscriptions, upsells, or ad impressions. AI makes that model more achievable by reducing the time and cost required to produce polished tools that are still available for public use, inspection, and improvement.

## Philosophy

The principles behind this project are simple:

- Software should be useful before it is profitable.
- Users should not have to pay just to access basic quality-of-life features.
- Ads should not be the default business model for every tool.
- Open source applications should be able to compete on quality as well as cost.
- AI should help expand public access to software creation, not only private productivity.

This project is built around the belief that free and open source software can match or outperform paid alternatives when the focus remains on usability, capability, and transparency instead of monetization strategy.

## What The Application Provides

## Features

- Import M3U playlists from URL, raw text, or local file upload.
- Manage playlists locally in the browser.
- Browse live TV, movies, series, and catch-up content.
- Play streams with HLS support, native fallback, Picture-in-Picture, fullscreen, and playback controls.
- Save favorites, recents, continue watching progress, and settings in local storage.
- Export and import app state as JSON.

The application is designed as a practical tool rather than a limited demonstration. Wherever possible, control remains with the user through a frontend-only architecture and browser-local persistence.

## Open Source And Public Release

This repository is intended for public use. The code can be reviewed, modified, extended, and reused as the basis for other free applications.

That matters for two reasons. First, it gives users more transparency and control than closed products. Second, it allows other developers to build on the work rather than starting from zero. That is one of the strongest practical arguments for combining AI-generated implementation with open source distribution.

## Position On Paid Alternatives

This project takes a clear but professional position: many paid applications in this category offer fewer features than they should, create unnecessary friction, or monetize functionality that does not reasonably justify a purchase price or advertising burden.

Some of the competitors that helped inspire this project include apps such as Televizo and Vu Player Pro. They represent the kind of market this application is intended to challenge: products that demonstrate there is demand for IPTV players, but also reinforce the need for stronger free and open source alternatives.

The existence of those products should not be treated as a limit on what free software can achieve. If AI can help produce capable applications efficiently, then open source projects should be able to compete directly with weaker paid alternatives by offering better value, better transparency, and a more respectful user experience.

## README

Community IPTV Player, or CTV for short, is a browser-only IPTV playlist manager and player built with React, TypeScript, Vite, Tailwind CSS, and `hls.js`.

This project was written 100% by an AI and released publicly.

The application is designed as a practical tool rather than a limited demonstration. Wherever possible, control remains with the user through a frontend-only architecture and browser-local persistence.

## Features

- Import M3U playlists from URL, raw text, or local file upload.
- Manage playlists locally in the browser.
- Browse live TV, movies, series, and catch-up content.
- Play streams with HLS support, native fallback, Picture-in-Picture, fullscreen, and playback controls.
- Save favorites, recents, continue watching progress, and settings in local storage.
- Export and import app state as JSON.

## Technical Approach

This application is built as a frontend-only project with local browser storage for user data. That keeps the setup simple and makes the app easy to run, inspect, and deploy.

Core stack:

- React
- TypeScript
- Vite
- Tailwind CSS
- `hls.js`

The implementation approach is intentionally practical: keep the application lightweight, understandable, and easy for others to continue developing.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Usage

1. Start the app locally with `npm run dev`.
2. Import an M3U playlist from a URL, pasted text, or a local file.
3. Browse live TV, movies, series, or catch-up content.
4. Play content directly in the browser.
5. Save favorites, continue watching progress, and other settings locally in the app.

## Open Source

This repository is intended for public use. The code can be reviewed, modified, extended, and reused as the basis for other free applications.
