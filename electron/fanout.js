// fanout.js: which frames does a pushed channel actually have to reach?
//
// main.js's broadcast() walks mainFrame.framesInSubtree and sends to every
// frame, because webContents.send only reaches the main frame and the tab
// iframes must receive engine/forge/library pushes too (invariant 4). The cost
// of that is real but small; the WASTE was not small. Measured on this app,
// framesInSubtree is 7 whether or not the tabs have ever been opened (a
// src-less iframe still counts), while forge:status has 2 subscribers,
// engine-event has 2, and game-active and overlay-state have 1 each -- so
// 71-86% of every push went to a document with no listener for it, forever,
// including engine-event's 20 pushes a second during playback.
//
// So each frame reports the channels it actually listens to (preload.js does it
// from onChannel, the single place any push listener is registered), and this
// module answers the question broadcast() asks.
//
// THE RULE THAT KEEPS INVARIANT 4 INTACT: a frame that has not reported
// anything yet receives EVERYTHING. "Unknown" must fail towards sending, or a
// panel whose script has not run yet -- or any future frame that subscribes
// through some other path -- would silently stop receiving. Unsubscribing is
// deliberately NOT tracked either: a stale subscription costs one send, a
// missed one costs a bug of exactly the kind invariant 4 exists to prevent.
//
// If this ever stops working (an Electron change that hands out a different
// WebFrameMain object per lookup, say), every frame simply reads as unknown and
// the app is back to broadcasting to all of them: slower, never wrong.
'use strict';

// Keyed by the WebFrameMain object itself, so a reload or a navigation is a new
// frame with no subscriptions, and a frame that goes away is collected.
const subs = new WeakMap();

function noteSubscription(frame, channel) {
  if (!frame || typeof channel !== 'string' || !channel) return;
  markReady(frame);
  subs.get(frame).add(channel);
}

// "This document has finished loading and has told you everything it listens
// to." Without it, a panel that subscribes to NOTHING (the Editor, Audition
// and Logs all do) is indistinguishable from one whose scripts have not run
// yet, and both have to be sent to. preload.js sends it on window load, after
// every listener the document registers at start-up already reported.
function markReady(frame) {
  if (!frame) return;
  if (!subs.has(frame)) subs.set(frame, new Set());
}

// True when the frame has never reported (unknown -> send) or has this channel.
function frameWants(frame, channel) {
  if (!frame) return false;
  const set = subs.get(frame);
  return !set || set.has(channel);
}

function subscriptionsOf(frame) {
  const set = frame && subs.get(frame);
  return set ? [...set] : null;                 // null means "never reported"
}

module.exports = { noteSubscription, markReady, frameWants, subscriptionsOf };
