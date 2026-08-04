import { useEffect } from "react";
import { Cast, ChevronLeft, MonitorSpeaker, X } from "lucide-react";
import type { RelayCastDevice } from "../../hooks/useChromecast";

interface CastDevicePickerProps {
  /** Discovered devices; null means the picker is closed. */
  devices: RelayCastDevice[] | null;
  /** Device chosen from the list and awaiting confirmation, if any. */
  pending: RelayCastDevice | null;
  /** What would start playing on the device, shown in the confirmation. */
  itemTitle: string;
  onPick: (device: RelayCastDevice) => void;
  onConfirm: () => void;
  onDismissConfirm: () => void;
  onCancel: () => void;
}

const deviceDetail = (device: RelayCastDevice): string =>
  [device.model, device.host].filter(Boolean).join(" · ");

/**
 * Two-step Cast target selection: pick a device from the discovered list, then
 * confirm it. Deliberately never auto-selects, not even when discovery returns
 * exactly one device — starting a cast moves playback onto a TV that may well
 * be in a different room, which is not something a single click should do.
 */
export const CastDevicePicker = ({
  devices,
  pending,
  itemTitle,
  onPick,
  onConfirm,
  onDismissConfirm,
  onCancel,
}: CastDevicePickerProps) => {
  // The player binds its shortcuts on document/window (space, arrows, f, m), so
  // while this dialog is up they have to be intercepted before they get there —
  // capture phase on window runs ahead of both.
  useEffect(() => {
    if (!devices) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (pending) onDismissConfirm();
        else onCancel();
        return;
      }
      if ([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "f", "m"].includes(event.key)) {
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [devices, pending, onCancel, onDismissConfirm]);

  if (!devices || devices.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={pending ? "Confirm Cast device" : "Choose a Cast device"}
    >
      <div className="panel w-full max-w-sm overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            {pending ? (
              <button
                type="button"
                className="control-btn h-7 w-7 shrink-0"
                onClick={onDismissConfirm}
                aria-label="Back to device list"
              >
                <ChevronLeft size={16} />
              </button>
            ) : (
              <Cast size={18} className="shrink-0 text-cyan-300" aria-hidden />
            )}
            <h2 className="truncate text-base font-semibold text-slate-100">
              {pending ? "Confirm" : "Cast to a device"}
            </h2>
          </div>
          <button type="button" className="control-btn shrink-0" onClick={onCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {pending ? (
          <div className="space-y-4 px-4 py-4">
            <p className="text-sm leading-relaxed text-slate-200">
              Start casting to <span className="font-semibold text-cyan-200">{pending.name}</span>?
            </p>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Now playing</p>
              <p className="mt-0.5 truncate text-sm text-slate-100">{itemTitle}</p>
              {deviceDetail(pending) ? (
                <p className="mt-1.5 truncate text-xs text-slate-400">{deviceDetail(pending)}</p>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-slate-400">
              Playback moves to that device and this player becomes the remote control.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary flex-1 px-3 py-2 text-sm" onClick={onConfirm}>
                <Cast size={15} aria-hidden />
                Cast
              </button>
              <button type="button" className="btn flex-1 px-3 py-2 text-sm" onClick={onDismissConfirm}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="px-2 py-2">
            <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {devices.length} device{devices.length === 1 ? "" : "s"} found
            </p>
            <ul className="max-h-72 overflow-y-auto">
              {devices.map((device) => (
                <li key={`${device.host}:${device.port}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-white/10"
                    onClick={() => onPick(device)}
                  >
                    <MonitorSpeaker size={18} className="shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-100">{device.name}</span>
                      {deviceDetail(device) ? (
                        <span className="block truncate text-xs text-slate-500">{deviceDetail(device)}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-1 block w-full rounded-lg px-2.5 py-2 text-left text-xs text-slate-500 transition hover:bg-white/10"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
