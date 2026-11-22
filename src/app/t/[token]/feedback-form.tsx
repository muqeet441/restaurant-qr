"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";

export function FeedbackForm({ sessionId }: { sessionId: string }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) return <p className="text-sm text-ink-soft">Thanks for your feedback!</p>;

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) return;
        const { error } = await createClient().rpc("submit_feedback", {
          p_session_id: sessionId,
          p_rating: rating,
          p_comment: comment.trim() || null,
        });
        if (error) setError(friendlyError(error));
        else setSent(true);
      }}
    >
      <p className="text-sm font-medium">How was your visit?</p>
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            onClick={() => setRating(n)}
            className={`text-3xl leading-none ${n <= rating ? "text-amber-500" : "text-line"}`}
          >
            ★
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Anything you'd like to tell us? (optional)"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">Send feedback</button>
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
