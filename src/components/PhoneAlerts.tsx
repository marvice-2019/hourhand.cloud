"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { sendTestPushAlert, turnOffPushAlerts, turnOnPushAlerts, type PushActionResult } from "@/app/dashboard/settings/push-actions";

// The Settings card's controls for phone alerts on this one device. The server keeps one row per device
// (src/lib/push); this asks the browser for permission and a push address, and hands it over.

export interface PhoneAlertsLabels {
  unsupported: string; installFirst: string; blocked: string; on: string; devices: string;
  turnOn: string; turnOff: string; test: string; testSent: string; error: string;
}

type State = "checking" | "unsupported" | "install" | "blocked" | "off" | "on";

/** The VAPID public key as the bytes pushManager.subscribe wants. */
function keyBytes(base64url: string): Uint8Array {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** "Chrome on Android": enough for the host to tell their devices apart. Never sent anywhere but our own server. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser"; // i18n-ignore: not copy
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : ""; // i18n-ignore: not copy
  return os ? `${browser} on ${os}` : browser; // i18n-ignore: not copy
}

/** iPhone and iPad only allow alerts for a site added to the Home Screen and opened from there. */
function needsInstall(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

export function PhoneAlerts({ publicKey, initialDevices, labels }: { publicKey: string; initialDevices: number; labels: PhoneAlertsLabels }) {
  const [state, setState] = useState<State>("checking");
  const [devices, setDevices] = useState(initialDevices);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { // i18n-ignore: not copy
        if (!cancelled) setState(needsInstall() ? "install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") { if (!cancelled) setState("blocked"); return; }
      const sub = await (await registration()).pushManager.getSubscription();
      if (cancelled) return;
      setState(sub && Notification.permission === "granted" ? "on" : "off");
      // Already on here: save it again, in case the server dropped it or the push address changed.
      if (sub && Notification.permission === "granted") {
        const res = await turnOnPushAlerts(sub.toJSON(), deviceName());
        if (!cancelled && res.ok) setDevices(res.devices);
      }
    })().catch(() => { if (!cancelled) setState("unsupported"); });
    return () => { cancelled = true; };
  }, []);

  const done = (res: PushActionResult, okText?: string) => {
    if (res.ok) { setDevices(res.devices); setNote(okText ? { ok: true, text: okText } : null); }
    else setNote({ ok: false, text: labels.error });
  };

  const turnOn = async () => {
    setBusy(true); setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(permission === "denied" ? "blocked" : "off"); return; }
      const reg = await registration();
      // A subscription made with an older key can't be reused: drop it and make a new one.
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
      const res = await turnOnPushAlerts(sub.toJSON(), deviceName());
      if (res.ok) setState("on");
      else await sub.unsubscribe();
      done(res);
    } catch {
      setNote({ ok: false, text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true); setNote(null);
    try {
      const sub = await (await registration()).pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      done(await turnOffPushAlerts(sub?.endpoint ?? ""));
      setState("off");
    } catch {
      setNote({ ok: false, text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true); setNote(null);
    try { done(await sendTestPushAlert(), labels.testSent); } catch { setNote({ ok: false, text: labels.error }); } finally { setBusy(false); }
  };

  if (state === "checking") return null;
  if (state === "unsupported") return <p className="mt-3 text-sm text-text">{labels.unsupported}</p>;
  if (state === "install") return <p className="mt-3 text-sm text-text">{labels.installFirst}</p>;
  if (state === "blocked") return <p className="mt-3 text-sm text-text">{labels.blocked}</p>;
  return (
    <div className="mt-4">
      {state === "on" && <p className="text-sm text-success">{labels.on}</p>}
      {devices > 0 && <p className="mt-1 text-sm text-text-muted">{labels.devices.replace("{n}", String(devices))}</p>}
      <div className="mt-3 flex flex-wrap gap-3">
        {state === "on" ? (
          <>
            <Button onClick={test} loading={busy}>{labels.test}</Button>
            <Button variant="secondary" onClick={turnOff} disabled={busy}>{labels.turnOff}</Button>
          </>
        ) : (
          <Button onClick={turnOn} loading={busy}>{labels.turnOn}</Button>
        )}
      </div>
      {note && <p role={note.ok ? "status" : "alert"} className={`mt-2 text-sm ${note.ok ? "text-success" : "text-danger"}`}>{note.text}</p>}
    </div>
  );
}
