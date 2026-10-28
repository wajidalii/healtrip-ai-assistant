"use client";

import { useLocale } from "@/i18n/locale";

/** Red banner rendered whenever a recommendation carries `urgency: "emergency"`; `role="alert"` is implicitly assertive. */
export function EmergencyBanner() {
  const { t } = useLocale();
  return (
    <div role="alert" className="rounded-lg border-2 border-red-600 bg-red-50 p-4 text-red-900">
      <p className="text-base font-bold">{t.emergencyBanner.title}</p>
      <p className="mt-1 text-sm">{t.emergencyBanner.body}</p>
    </div>
  );
}
