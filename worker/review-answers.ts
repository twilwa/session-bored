// ABOUTME: Resolves custom proposal answers from the immutable form version pinned to a submission.
// ABOUTME: Applies the same default-hidden blind-review boundary to human and AI review surfaces.
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  formVersionFields,
  formVersions,
  submissionValues,
} from "../db/schema.ts";

const builtInProposalFieldKeys = new Set([
  "abstract",
  "audience_level",
  "format",
  "notes_for_reviewers",
  "session_title",
  "speaker_bio",
  "track",
]);

export interface ReviewProposalAnswer {
  key: string;
  label: string;
  value: string | number | boolean | string[] | null;
}

export interface ReviewProposalAnswerRow extends ReviewProposalAnswer {
  valueId: string | null;
  visibleInBlindReview: boolean | null | undefined;
}

type ReviewDatabase = ReturnType<typeof drizzle>;

export function selectReviewProposalAnswers(
  answers: ReviewProposalAnswerRow[],
  anonymized: boolean,
): ReviewProposalAnswer[] {
  return answers
    .filter((answer) => answer.valueId !== null && !builtInProposalFieldKeys.has(answer.key))
    .filter((answer) => !anonymized || answer.visibleInBlindReview === true)
    .map(({ key, label, value }) => ({ key, label, value }));
}

export async function reviewProposalAnswers(
  database: ReviewDatabase,
  submission: { id: string; formId: string; formVersion: number },
  anonymized: boolean,
): Promise<ReviewProposalAnswer[]> {
  const answers = await database
    .select({
      valueId: submissionValues.id,
      key: formVersionFields.key,
      label: formVersionFields.label,
      value: submissionValues.value,
      visibleInBlindReview: formVersionFields.visibleInBlindReview,
    })
    .from(formVersionFields)
    .innerJoin(formVersions, eq(formVersionFields.formVersionId, formVersions.id))
    .leftJoin(
      submissionValues,
      and(
        eq(submissionValues.fieldId, formVersionFields.stableFieldId),
        eq(submissionValues.submissionId, submission.id),
      ),
    )
    .where(and(
      eq(formVersions.formId, submission.formId),
      eq(formVersions.version, submission.formVersion),
    ))
    .orderBy(asc(formVersionFields.sortOrder));

  return selectReviewProposalAnswers(answers, anonymized);
}
