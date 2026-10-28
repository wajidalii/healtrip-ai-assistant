"use client";

import { isToolName } from "@/i18n/dictionaries";
import { useLocale } from "@/i18n/locale";
import type { ToolActivityItem, ToolStatus } from "./useAgentStream";

const STATUS_STYLES: Record<ToolStatus, string> = {
  running: "border-sky-300 bg-sky-50 text-sky-800",
  ok: "border-emerald-300 bg-emerald-50 text-emerald-800",
  error: "border-red-300 bg-red-50 text-red-800",
};

const STATUS_ICON: Record<ToolStatus, string> = { running: "…", ok: "✓", error: "✕" };

/** One chip per tool call so the user can see what the agent is doing (and that it is grounded in tools). */
export function ToolActivity({ items }: { items: ToolActivityItem[] }) {
  const { t } = useLocale();
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t.toolActivity}>
      {items.map((item) => {
        // Unknown tool names (future tools) fall back to the raw name rather than crashing.
        const label = isToolName(item.name) ? t.toolLabels[item.name] : item.name;
        const status = t.toolStatus[item.status];
        return (
          <li
            key={item.id}
            title={item.summary || undefined}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${STATUS_STYLES[item.status]}`}
          >
            <span aria-hidden="true">{STATUS_ICON[item.status]}</span>
            <span>{label}</span>
            <span className="sr-only">: {status}</span>
            {item.status !== "running" && item.summary ? (
              <span className="opacity-70" dir="auto">
                · {item.summary}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
