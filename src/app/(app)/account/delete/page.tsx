// src/app/(app)/account/delete/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AlertTriangle, Clock3, ShieldCheck, Trash2 } from "lucide-react";

import { coreGet, corePost, CoreError, idempotencyKey } from "@/lib/fetch-core";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Delete account · Polaris Coach",
  description:
    "Schedule a permanent deletion of your Polaris Coach account, drills, expressions, and transcripts.",
};

export const revalidate = 0;

const DELAY_OPTIONS = [
  { days: 0, label: "Immediately (no cooling-off period)" },
  { days: 3, label: "In 3 days (recommended)" },
  { days: 7, label: "In 7 days" },
] as const;

type DeleteJobStatus = "queued" | "running" | "finished" | "failed" | "canceled" | string;

type DeleteJob = {
  id: string;
  status: DeleteJobStatus;
  scheduled_at?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
};

type DeleteStatusResponse = {
  ok: boolean;
  job: DeleteJob | null;
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DeleteAccountPage({ searchParams }: { searchParams?: SearchParams }) {
  const user = await requireUser("/login");
  const job = await fetchDeletionStatus(user.id);

  const success = readFlag(searchParams, "queued");
  const errorCode = readString(searchParams, "error");

  return (
    <main className="space-y-8 pb-16">
      <header className="rounded-3xl border border-red-200 bg-white p-6 shadow-sm shadow-red-500/10 dark:bg-[#03111A]">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-red-500">Danger zone</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">
              Delete your Polaris Coach account
            </h1>
            <p className="mt-3 text-base text-slate-700 dark:text-slate-200">
              Deleting your account permanently removes drills, transcripts, saved expressions, and queued Practice Pack
              items. You will immediately lose access after the scheduled deletion runs.
            </p>
          </div>
          <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-200">
            Need help?{" "}
            <a className="underline" href="mailto:polaris@chizsaleei.com">
              polaris@chizsaleei.com
            </a>
          </div>
        </div>
        <ul className="mt-6 grid gap-3 text-sm text-slate-700 dark:text-slate-200 md:grid-cols-2">
          <li className="flex items-start gap-3 rounded-2xl border border-slate-200/70 p-4">
            <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            <span>We queue the deletion so you can cancel from this page or by emailing support before it runs.</span>
          </li>
          <li className="flex items-start gap-3 rounded-2xl border border-slate-200/70 p-4">
            <Clock3 className="h-5 w-5 text-slate-500" aria-hidden="true" />
            <span>
              Exports you&apos;ve already downloaded remain yours, but we cannot restore drills after deletion completes.
            </span>
          </li>
        </ul>
      </header>

      {success && (
        <div
          role="status"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          Account deletion scheduled. We sent a confirmation email and will notify you when the job finishes.
        </div>
      )}
      {errorCode && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {errorCode === "confirm"
            ? "You must type DELETE exactly to confirm."
            : errorCode === "pending"
            ? "A deletion job is already queued for your account."
            : "We could not reach the delete service. Try again or contact support."}
        </div>
      )}

      <section className="grid gap-6 lg:grid-cols-[1fr,1.2fr]">
        <DeletionStatusCard job={job} />
        <DeletionForm job={job} />
      </section>

      <div className="text-sm text-slate-500">
        Changed your mind?{" "}
        <Link className="font-semibold text-slate-900 underline" href="/account">
          Return to account settings
        </Link>
      </div>
    </main>
  );
}

function DeletionStatusCard({ job }: { job: DeleteJob | null }) {
  const hasJob = Boolean(job);
  const statusLabel = job ? describeStatus(job.status) : "No request on file";
  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-900/5 dark:bg-[#03111A]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current status</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">{statusLabel}</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {job
              ? getStatusCopy(job)
              : "No deletion is scheduled. Use the form to queue a deletion request whenever you are ready."}
          </p>
        </div>
        <div className="rounded-2xl bg-slate-100 p-3 text-slate-600 dark:bg-slate-900/40 dark:text-slate-200">
          <Trash2 className="h-6 w-6" aria-hidden="true" />
        </div>
      </div>

      <dl className="mt-6 grid gap-4 text-sm text-slate-600 dark:text-slate-300 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/30">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Requested on</dt>
          <dd className="mt-1 font-mono">
            {hasJob && formatDate(job?.created_at) ? formatDate(job?.created_at) : "Not requested"}
          </dd>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/30">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scheduled for</dt>
          <dd className="mt-1 font-mono">
            {hasJob && formatDate(job?.scheduled_at) ? formatDate(job?.scheduled_at) : "Not scheduled"}
          </dd>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/30">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Completed</dt>
          <dd className="mt-1 font-mono">{job?.finished_at ? formatDate(job.finished_at) : job ? "Pending" : "—"}</dd>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/30">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reference</dt>
          <dd className="mt-1 font-mono">{job?.id ?? "—"}</dd>
        </div>
      </dl>

      {job?.error && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Last attempt failed</p>
            <p className="text-red-800">{job.error}</p>
          </div>
        </div>
      )}
    </article>
  );
}

async function fetchDeletionStatus(userId: string): Promise<DeleteJob | null> {
  try {
    const response = await coreGet<DeleteStatusResponse>("/v1/account/delete/status", {
      headers: {
        "x-user-id": userId,
      },
      cache: "no-store",
    });
    return response.job ?? null;
  } catch (error) {
    console.error("[account/delete] status fetch failed", error);
    return null;
  }
}

function DeletionForm({ job }: { job: DeleteJob | null }) {
  const locked = Boolean(job && (job.status === "queued" || job.status === "running"));
  const defaultDelay = DELAY_OPTIONS[1]?.days ?? 3;
  return (
    <article className="rounded-3xl border border-red-200 bg-red-50/60 p-6 shadow-sm shadow-red-900/5 dark:bg-red-900/20">
      <h2 className="text-2xl font-semibold text-red-900 dark:text-white">Schedule deletion</h2>
      <p className="mt-2 text-sm text-red-800 dark:text-red-200">
        Deletion is irreversible. Type <span className="font-semibold">DELETE</span> to confirm. If a job is already
        queued you must wait for it to finish or contact support to cancel it.
      </p>

      <form action={scheduleDeletion} className="mt-6 space-y-4">
        <fieldset disabled={locked} className="space-y-4">
          <div>
            <label htmlFor="reason" className="text-sm font-medium text-red-900 dark:text-red-100">
              Why are you leaving? <span className="text-xs font-normal text-red-700">(optional)</span>
            </label>
            <textarea
              id="reason"
              name="reason"
              rows={3}
              maxLength={500}
              className="mt-2 w-full rounded-2xl border border-red-200 bg-white/70 px-4 py-3 text-sm text-red-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200 dark:bg-[#120708]"
              placeholder="Example: Switching to another coach program, cost, no longer practicing..."
            />
          </div>

          <div>
            <label htmlFor="delayDays" className="text-sm font-medium text-red-900 dark:text-red-100">
              When should the deletion run?
            </label>
            <select
              id="delayDays"
              name="delayDays"
              defaultValue={String(defaultDelay)}
              className="mt-2 w-full rounded-2xl border border-red-200 bg-white/70 px-4 py-3 text-sm text-red-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200 dark:bg-[#120708]"
            >
              {DELAY_OPTIONS.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="confirm" className="text-sm font-medium text-red-900 dark:text-red-100">
              Type DELETE to confirm
            </label>
            <input
              id="confirm"
              name="confirm"
              required
              inputMode="text"
              autoComplete="off"
              maxLength={10}
              className="mt-2 w-full rounded-2xl border border-red-200 bg-white/70 px-4 py-3 text-lg font-semibold uppercase tracking-wider text-red-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200 dark:bg-[#120708]"
            />
          </div>
        </fieldset>

        {locked && (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            A deletion job is already in progress. You can wait for the existing job to finish or email{" "}
            <a className="font-semibold underline" href="mailto:polaris@chizsaleei.com">
              polaris@chizsaleei.com
            </a>{" "}
            to cancel.
          </p>
        )}

        <button
          type="submit"
          className="w-full rounded-2xl bg-red-600 px-4 py-3 text-center text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-red-500 disabled:bg-red-300"
          disabled={locked}
        >
          {locked ? "Deletion queued" : "Schedule deletion"}
        </button>
      </form>
    </article>
  );
}

async function scheduleDeletion(formData: FormData) {
  "use server";
  const user = await requireUser("/login");
  const confirm = String(formData.get("confirm") ?? "").trim().toUpperCase();
  if (confirm !== "DELETE") {
    redirect(withQuery("/account/delete", { error: "confirm" }));
  }

  const reason = sanitizeReason(formData.get("reason"));
  const delayDays = clampInt(formData.get("delayDays"), 0, 30, 3);
  const scheduleAt = delayDays > 0 ? new Date(Date.now() + delayDays * 86_400_000).toISOString() : undefined;

  try {
    await corePost(
      "/v1/account/delete",
      {
        confirm: "DELETE",
        reason: reason || undefined,
        scheduleAt,
      },
      {
        headers: {
          "x-user-id": user.id,
          "idempotency-key": idempotencyKey(),
        },
      },
    );
  } catch (error) {
    if (error instanceof CoreError && error.code === "confirmation_required") {
      redirect(withQuery("/account/delete", { error: "confirm" }));
    }
    if (error instanceof CoreError && error.code === "already_queued") {
      redirect(withQuery("/account/delete", { error: "pending" }));
    }
    console.error("[account/delete] queue failed", error);
    redirect(withQuery("/account/delete", { error: "core" }));
  }

  revalidatePath("/account");
  revalidatePath("/account/delete");
  redirect(withQuery("/account/delete", { queued: "1" }));
}

function sanitizeReason(input: FormDataEntryValue | null): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, 500);
}

function clampInt(value: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function describeStatus(status: DeleteJobStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "In progress";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status ? status[0]?.toUpperCase() + status.slice(1) : "Unknown";
  }
}

function getStatusCopy(job: DeleteJob) {
  switch (job.status) {
    case "queued":
      return "We scheduled your data for deletion. You can cancel before the scheduled time by contacting support.";
    case "running":
      return "Deletion is currently running. This usually completes within a few minutes.";
    case "finished":
      return "Deletion finished. You can still contact support within 30 days if you believe this was in error.";
    case "failed":
      return "Our worker could not complete the deletion. We will retry automatically.";
    default:
      return "Status updated. Reach out to support if you have questions.";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "";
  try {
    const date = new Date(value);
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return value;
  }
}

function readFlag(searchParams: SearchParams | undefined, key: string) {
  const value = readString(searchParams, key);
  return value === "1" || value === "true";
}

function readString(searchParams: SearchParams | undefined, key: string) {
  if (!searchParams) return undefined;
  const value = searchParams[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function withQuery(path: string, params?: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

