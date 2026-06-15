import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { IPTV_STREAM_USER_AGENT } from "./proxyShared";

export interface RestreamSession {
  id: string;
  sourceUrl: string;
  outputDir: string;
  process: ChildProcess;
  transcode: boolean;
  lastAccess: number;
}

const sessions = new Map<string, RestreamSession>();
const SESSION_TTL_MS = 120_000;
const startingSessions = new Map<string, Promise<RestreamSession>>();

const sessionIdForUrl = (sourceUrl: string): string =>
  createHash("sha256").update(sourceUrl).digest("hex").slice(0, 20);

const manifestPathFor = (outputDir: string): string => path.join(outputDir, "index.m3u8");

const buildFfmpegArgs = (sourceUrl: string, outputDir: string, transcode: boolean): string[] => {
  const manifestPath = manifestPathFor(outputDir);
  const segmentPattern = path.join(outputDir, "seg_%03d.ts").replace(/\\/g, "/");
  const referer = `${new URL(sourceUrl).protocol}//${new URL(sourceUrl).host}/`;

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-user_agent",
    IPTV_STREAM_USER_AGENT,
    "-headers",
    `Referer: ${referer}\r\n`,
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-fflags",
    "+genpts+igndts",
    "-i",
    sourceUrl,
  ];

  if (transcode) {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
    );
  } else {
    args.push("-c", "copy");
  }

  args.push(
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "15",
    "-hls_flags",
    "append_list+omit_endlist+program_date_time",
    "-hls_segment_filename",
    segmentPattern,
    manifestPath.replace(/\\/g, "/"),
  );

  return args;
};

const waitForManifest = async (manifestPath: string, timeoutMs: number): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(manifestPath)) {
      const content = await readFile(manifestPath, "utf8");
      if (content.includes("#EXTM3U")) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for ffmpeg HLS manifest");
};

const killProcess = (process: ChildProcess): void => {
  if (process.exitCode != null) return;
  process.kill("SIGTERM");
  setTimeout(() => {
    if (process.exitCode == null) process.kill("SIGKILL");
  }, 2000).unref();
};

const runFfmpegSession = async (sourceUrl: string, transcode: boolean): Promise<RestreamSession> => {
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary not found. Install ffmpeg-static or system ffmpeg.");
  }

  const id = sessionIdForUrl(sourceUrl);
  const outputDir = path.join(os.tmpdir(), "iptv-restream", id);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const manifestPath = manifestPathFor(outputDir);
  const process = spawn(ffmpegPath, buildFfmpegArgs(sourceUrl, outputDir, transcode), {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  try {
    await waitForManifest(manifestPath, transcode ? 25_000 : 15_000);
  } catch (error) {
    killProcess(process);
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    const message = stderr.trim() || (error instanceof Error ? error.message : "ffmpeg failed");
    throw new Error(message);
  }

  const session: RestreamSession = {
    id,
    sourceUrl,
    outputDir,
    process,
    transcode,
    lastAccess: Date.now(),
  };

  process.on("exit", () => {
    if (sessions.get(id) === session) sessions.delete(id);
    void rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  });

  sessions.set(id, session);
  return session;
};

const isSessionHealthy = (session: RestreamSession): boolean =>
  session.process.exitCode == null && existsSync(manifestPathFor(session.outputDir));

export const invalidateRestreamSession = async (sourceUrl: string): Promise<void> => {
  const id = sessionIdForUrl(sourceUrl);
  startingSessions.delete(id);
  const existing = sessions.get(id);
  if (!existing) return;
  sessions.delete(id);
  killProcess(existing.process);
  await rm(existing.outputDir, { recursive: true, force: true }).catch(() => undefined);
};

export const getOrStartRestreamSession = async (
  sourceUrl: string,
  forceRestart = false,
): Promise<RestreamSession> => {
  const id = sessionIdForUrl(sourceUrl);
  if (forceRestart) {
    await invalidateRestreamSession(sourceUrl);
  }

  const existing = sessions.get(id);
  if (existing && isSessionHealthy(existing)) {
    existing.lastAccess = Date.now();
    return existing;
  }
  if (existing) {
    sessions.delete(id);
    killProcess(existing.process);
    await rm(existing.outputDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const pending = startingSessions.get(id);
  if (pending) return pending;

  const startPromise = (async () => {
    try {
      try {
        return await runFfmpegSession(sourceUrl, false);
      } catch (copyError) {
        console.warn("[IPTV][Restream] Stream copy failed, retrying with transcode", {
          sourceUrl,
          error: copyError instanceof Error ? copyError.message : String(copyError),
        });
        return await runFfmpegSession(sourceUrl, true);
      }
    } finally {
      startingSessions.delete(id);
    }
  })();

  startingSessions.set(id, startPromise);
  return startPromise;
};

export const touchRestreamSession = (sessionId: string): RestreamSession | null => {
  const session = sessions.get(sessionId);
  if (!session || session.process.exitCode != null) return null;
  session.lastAccess = Date.now();
  return session;
};

export const readRestreamManifest = async (session: RestreamSession): Promise<string> => {
  const manifestPath = manifestPathFor(session.outputDir);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (session.process.exitCode != null) {
      throw new Error("ffmpeg restream stopped unexpectedly");
    }
    try {
      const content = await readFile(manifestPath, "utf8");
      if (content.includes("#EXTM3U")) return content;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Restream manifest not ready");
};

export const readRestreamSegment = async (session: RestreamSession, fileName: string): Promise<Buffer> => {
  const safeName = path.basename(fileName);
  const segmentPath = path.join(session.outputDir, safeName);
  if (!segmentPath.startsWith(session.outputDir)) {
    throw new Error("Invalid segment path");
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (session.process.exitCode != null) {
      throw new Error("ffmpeg restream stopped unexpectedly");
    }
    try {
      return await readFile(segmentPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Restream segment not ready: ${safeName}`);
};

export const rewriteRestreamManifest = (content: string, sessionId: string): string =>
  content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (trimmed.includes("://")) return line;
      const fileName = trimmed.split("?")[0];
      return `/api/restream/${sessionId}/${fileName}`;
    })
    .join("\n");

const cleanupIdleSessions = (): void => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      killProcess(session.process);
      sessions.delete(id);
      void rm(session.outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

if (typeof setInterval !== "undefined") {
  setInterval(cleanupIdleSessions, 30_000).unref?.();
}
