/**
 * OrientSession use case: detect where the session opened inside a camp and
 * produce the orientation note + status-line text the omp adapters render.
 */
import { buildOrientationNote } from "@/domain/orientation.js";
import { statusLineText, summarizeProgress } from "@/domain/progress.js";
import type { CampLocation, FestivalProgress } from "@/domain/types.js";
import type { CampDetect } from "@/ports.js";

export interface Orientation {
  location: CampLocation;
  note: string;
  statusLine: string;
  progress?: FestivalProgress;
}

export async function orientSession(
  cwd: string,
  detect: CampDetect,
): Promise<Orientation> {
  const location = await detect.locate(cwd);
  if (location.kind === "outside" || !location.campRoot) {
    return { location, note: "", statusLine: "" };
  }
  const festivalDir =
    location.festivalDir ?? (await detect.activeFestival(location.campRoot));
  if (!festivalDir) {
    const statusLine = `🏕 ${location.campName ?? "camp"}`;
    return {
      location,
      note: buildOrientationNote({ location }),
      statusLine,
    };
  }
  const resolved: CampLocation = { ...location, festivalDir };
  const events = await detect.readProgress(festivalDir);
  const progress = summarizeProgress(events);
  const statusLine = statusLineText({
    campName: location.campName,
    festivalId: location.festivalId,
    progress,
  });
  const note = buildOrientationNote({ location: resolved, progress });
  return { location: resolved, note, statusLine, progress };
}
