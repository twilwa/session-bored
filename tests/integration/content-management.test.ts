// ABOUTME: Verifies organizer deliverable tracking, bulk archives, and cross-role discussion through real HTTP routes.
// ABOUTME: Proves uploads, deadlines, approval state, event scope, and speaker ownership stay connected.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { events, files, people, speakers } from "../../db/schema.ts";
import type { PortalFileVersion } from "../../shared/api.ts";
import worker from "../../worker/index.ts";
import { withActiveSpeakerEvent } from "./portal-request.ts";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(`http://example.test${withActiveSpeakerEvent(path)}`, init, env);
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function pdfUpload(
  name: string,
  bytes: number[] | Uint8Array<ArrayBuffer> = [1, 2, 3, 4],
): FormData {
  const formData = new FormData();
  const contents = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  formData.append("file", new File([contents], name, { type: "application/pdf" }));
  formData.append("displayedRequestKind", "document");
  return formData;
}

const eventId = "evt_devflow_conf_2027";
const organizerCredentials = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };
const reviewerCredentials = { email: "sbek-reviewer@example.com", password: "SbekTest!2027-rev" };
const priyaCredentials = { email: "sbek-speaker@example.com", password: "SbekTest!2027-spk" };
const marcusCredentials = { email: "sbek-speaker2@example.com", password: "SbekTest!2027-spk2" };

describe("content management", () => {
  let organizerCookie: string;
  let priyaCookie: string;
  let marcusCookie: string;

  beforeEach(async () => {
    await request("/api/health");
    organizerCookie = await signIn(organizerCredentials.email, organizerCredentials.password);
    priyaCookie = await signIn(priyaCredentials.email, priyaCredentials.password);
    marcusCookie = await signIn(marcusCredentials.email, marcusCredentials.password);
  });

  it("shows requested, overdue, and delivered file work from the canonical assignment and upload records", async () => {
    const overdueAt = "2026-08-01T12:00:00.000Z";
    const deadline = await request(`/api/events/${eventId}/tasks/tsk_fixture_1`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ dueAt: overdueAt }),
    });
    expect(deadline.status).toBe(200);

    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("devflow-slides.pdf"),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json<{ fileId: string; version: number }>();

    const response = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      metrics: { total: number; requested: number; overdue: number; delivered: number };
      items: Array<{
        taskId: string;
        speaker: { id: string; name: string; email: string };
        task: { title: string; dueAt: string | null };
        status: "requested" | "overdue" | "delivered";
        file: null | {
          id: string;
          displayName: string;
          version: number;
          sizeBytes: number;
          uploadedAt: string;
          downloadUrl: string;
        };
      }>;
    }>();

    expect(payload.metrics).toMatchObject({ total: 2, requested: 0, overdue: 1, delivered: 1 });
    expect(payload.items.find((item) => item.taskId === "tsk_fixture_1")).toMatchObject({
      speaker: { id: "spk_priya_devflow_2027", name: "Priya Raman", email: "sbek-speaker@example.com" },
      task: { title: "Upload headshot", dueAt: overdueAt },
      status: "overdue",
      file: null,
    });
    expect(payload.items.find((item) => item.taskId === "tsk_fixture_3")).toMatchObject({
      status: "delivered",
      file: {
        id: uploaded.fileId,
        displayName: "devflow-slides.pdf",
        version: uploaded.version,
        sizeBytes: 4,
        downloadUrl: `/api/portal/files/${uploaded.fileId}?eventId=${eventId}`,
      },
    });
  });

  it("reports a fileless request completed by an organizer as complete rather than overdue", async () => {
    const beforeResponse = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    const before = await beforeResponse.json<{
      metrics: { total: number; requested: number; overdue: number; completed: number; delivered: number };
    }>();
    const emptyRequestResponse = await request(`/api/events/${eventId}/tasks`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload headshot for delivered-count coverage",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(emptyRequestResponse.status).toBe(201);
    const emptyRequest = await emptyRequestResponse.json<{ id: string }>();
    const deliveredRequestResponse = await request(`/api/events/${eventId}/tasks`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload deck for delivered-count coverage",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(deliveredRequestResponse.status).toBe(201);
    const deliveredRequest = await deliveredRequestResponse.json<{ id: string }>();

    const completedAssignment = await request(
      `/api/events/${eventId}/tasks/${emptyRequest.id}/assignees/spk_priya_devflow_2027`,
      {
        method: "PATCH",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      },
    );
    expect(completedAssignment.status).toBe(200);

    const overdueDeadline = await request(`/api/events/${eventId}/tasks/${emptyRequest.id}`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ dueAt: "2026-01-15T23:59:59.000Z" }),
    });
    expect(overdueDeadline.status).toBe(200);

    const upload = await request(`/api/portal/tasks/${deliveredRequest.id}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("delivered-slides.pdf"),
    });
    expect(upload.status).toBe(201);

    const response = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      metrics: { total: number; requested: number; overdue: number; completed: number; delivered: number };
      items: Array<{
        taskId: string;
        assignment: { status: string };
        status: "requested" | "overdue" | "completed" | "delivered";
        file: null | { displayName: string };
      }>;
    }>();

    expect(payload.metrics).toMatchObject({
      total: before.metrics.total + 2,
      requested: before.metrics.requested,
      overdue: before.metrics.overdue,
      completed: before.metrics.completed + 1,
      delivered: before.metrics.delivered + 1,
    });
    expect(payload.items.find((item) => item.taskId === emptyRequest.id)).toMatchObject({
      assignment: { status: "completed" },
      status: "completed",
      file: null,
    });
    expect(payload.items.find((item) => item.taskId === deliveredRequest.id)).toMatchObject({
      assignment: { status: "completed" },
      status: "delivered",
      file: { displayName: "delivered-slides.pdf" },
    });
  });

  it("gives organizers the speaker's complete downloadable file version history", async () => {
    const taskResponse = await request(`/api/events/${eventId}/tasks`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload deck for version-history coverage",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = await taskResponse.json<{ id: string }>();

    const firstUpload = await request(`/api/portal/tasks/${task.id}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("draft-deck.pdf"),
    });
    expect(firstUpload.status).toBe(201);
    const first = await firstUpload.json<{ fileId: string }>();

    const secondUpload = await request(`/api/portal/tasks/${task.id}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("final-deck.pdf"),
    });
    expect(secondUpload.status).toBe(201);

    const organizerResponse = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(organizerResponse.status).toBe(200);
    const organizerPayload = await organizerResponse.json<{
      items: Array<{
        taskId: string;
        file: null | {
          id: string;
          versions: PortalFileVersion[];
        };
      }>;
    }>();
    const organizerFile = organizerPayload.items.find((item) => item.taskId === task.id)?.file;

    const speakerResponse = await request("/api/speaker/content", {
      headers: { cookie: priyaCookie },
    });
    expect(speakerResponse.status).toBe(200);
    const speakerPayload = await speakerResponse.json<{
      files: Array<{ fileId: string; versions: PortalFileVersion[] }>;
    }>();
    const speakerFile = speakerPayload.files.find((file) => file.fileId === first.fileId);

    expect(organizerFile?.versions).toEqual(speakerFile?.versions);
    expect(organizerFile?.versions).toEqual([
      expect.objectContaining({
        version: 2,
        displayName: "final-deck.pdf",
        sizeBytes: 4,
        current: true,
        supersededByMerge: false,
        downloadUrl: `/api/portal/files/${first.fileId}?version=2&eventId=${eventId}`,
      }),
      expect.objectContaining({
        version: 1,
        displayName: "draft-deck.pdf",
        sizeBytes: 4,
        current: false,
        supersededByMerge: false,
        downloadUrl: `/api/portal/files/${first.fileId}?version=1&eventId=${eventId}`,
      }),
    ]);

    const previousVersion = await request(`/api/portal/files/${first.fileId}?version=1`, {
      headers: { cookie: organizerCookie },
    });
    expect(previousVersion.status).toBe(200);
    expect(previousVersion.headers.get("content-disposition")).toBe('attachment; filename="draft-deck.pdf"');
  });

  it("keeps the organizer listing private and refuses another speaker's file download", async () => {
    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("organizer-only-history.pdf"),
    });
    expect(upload.status).toBe(201);
    const { fileId } = await upload.json<{ fileId: string }>();
    const reviewerCookie = await signIn(reviewerCredentials.email, reviewerCredentials.password);

    for (const cookie of [priyaCookie, marcusCookie, reviewerCookie]) {
      const listing = await request(`/api/events/${eventId}/deliverables`, { headers: { cookie } });
      expect(listing.status).toBe(403);
      await expect(listing.json()).resolves.toEqual({ error: "forbidden" });
    }

    const anotherSpeakerDownload = await request(`/api/portal/files/${fileId}`, {
      headers: { cookie: marcusCookie },
    });
    expect(anotherSpeakerDownload.status).toBe(403);
    await expect(anotherSpeakerDownload.json()).resolves.toEqual({ error: "forbidden" });

    const reviewerDownload = await request(`/api/portal/files/${fileId}`, {
      headers: { cookie: reviewerCookie },
    });
    expect(reviewerDownload.status).toBe(403);
    await expect(reviewerDownload.json()).resolves.toEqual({ error: "forbidden" });

    const organizerDownload = await request(`/api/portal/files/${fileId}`, {
      headers: { cookie: organizerCookie },
    });
    expect(organizerDownload.status).toBe(200);
  });

  it("downloads selected deliverables as a ZIP containing their latest versions", async () => {
    const firstUpload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("draft-deck.pdf", [1, 2, 3, 4]),
    });
    expect(firstUpload.status).toBe(201);
    const first = await firstUpload.json<{ fileId: string }>();

    const latestUpload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("final-deck.pdf", [5, 6, 7, 8]),
    });
    expect(latestUpload.status).toBe(201);

    const secondTaskResponse = await request(`/api/events/${eventId}/tasks`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "file_request",
        title: "Upload speaker notes",
        speakerIds: ["spk_priya_devflow_2027"],
      }),
    });
    expect(secondTaskResponse.status).toBe(201);
    const secondTask = await secondTaskResponse.json<{ id: string }>();
    const secondUpload = await request(`/api/portal/tasks/${secondTask.id}/files`, {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("speaker-notes.pdf", [9, 10, 11, 12]),
    });
    expect(secondUpload.status).toBe(201);
    const second = await secondUpload.json<{ fileId: string }>();

    const archive = await request(`/api/events/${eventId}/files/archive`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ fileIds: [second.fileId, first.fileId] }),
    });

    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(archive.headers.get("content-disposition")).toBe(
      'attachment; filename="evt_devflow_conf_2027-files.zip"',
    );
    const bytes = new Uint8Array(await archive.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const files = unzipSync(bytes);
    const expected = [
      {
        fileId: first.fileId,
        path: `Priya Raman/Upload final slides by 2027-05-01/${first.fileId}-final-deck.pdf`,
        bytes: [5, 6, 7, 8],
      },
      {
        fileId: second.fileId,
        path: `Priya Raman/Upload speaker notes/${second.fileId}-speaker-notes.pdf`,
        bytes: [9, 10, 11, 12],
      },
    ].sort((left, right) => left.fileId.localeCompare(right.fileId));
    expect(Object.keys(files)).toEqual(expected.map((file) => file.path));
    for (const file of expected) {
      expect([...files[file.path]!]).toEqual(file.bytes);
    }
    expect(Object.keys(files).join("\n")).not.toContain("draft-deck.pdf");
  });

  it("streams several large selected deliverables instead of buffering the archive", async () => {
    const fileSize = 4 * 1024 * 1024;
    const selectedFiles: Array<{ fileId: string; marker: number }> = [];
    for (const [index, marker] of [17, 34, 51].entries()) {
      const taskResponse = await request(`/api/events/${eventId}/tasks`, {
        method: "POST",
        headers: { cookie: organizerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "file_request",
          title: `Upload large archive file ${index + 1}`,
          speakerIds: ["spk_priya_devflow_2027"],
        }),
      });
      expect(taskResponse.status).toBe(201);
      const task = await taskResponse.json<{ id: string }>();
      const contents = new Uint8Array(fileSize);
      contents.fill(marker);
      const uploadResponse = await request(`/api/portal/tasks/${task.id}/files`, {
        method: "POST",
        headers: { cookie: priyaCookie },
        body: pdfUpload(`large-${index + 1}.pdf`, contents),
      });
      expect(uploadResponse.status).toBe(201);
      const uploaded = await uploadResponse.json<{ fileId: string }>();
      selectedFiles.push({ fileId: uploaded.fileId, marker });
    }

    const archive = await request(`/api/events/${eventId}/files/archive`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ fileIds: selectedFiles.map((file) => file.fileId) }),
    });

    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-length")).toBeNull();
    const reader = archive.body?.getReader();
    expect(reader).toBeDefined();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.length).toBeGreaterThan(selectedFiles.length);
    expect(chunks[0]!.byteLength).toBeLessThan(fileSize);

    const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const archiveBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      archiveBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const files = unzipSync(archiveBytes);
    expect(Object.keys(files)).toHaveLength(selectedFiles.length);
    for (const selected of selectedFiles) {
      const path = Object.keys(files).find((name) => name.includes(selected.fileId));
      expect(path).toBeDefined();
      const contents = files[path!]!;
      expect(contents.byteLength).toBe(fileSize);
      expect(contents[0]).toBe(selected.marker);
      expect(contents.at(-1)).toBe(selected.marker);
    }
  });

  it("enforces organizer and event scope when generating a file archive", async () => {
    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("event-scoped.pdf"),
    });
    expect(upload.status).toBe(201);
    const file = await upload.json<{ fileId: string }>();
    const requestArchive = (event: string, cookie: string) => request(
      `/api/events/${event}/files/archive`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ fileIds: [file.fileId] }),
      },
    );

    expect((await requestArchive(eventId, priyaCookie)).status).toBe(403);
    expect((await requestArchive("evt_another_event", organizerCookie)).status).toBe(400);
  });

  it("surfaces session content awaiting approval without changing its status", async () => {
    const accepted = await request(`/api/events/${eventId}/disposition`, {
      method: "PATCH",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionIds: ["sub_ci_monorepo"], status: "accepted" }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json<{ handoffs: Array<{ session: { id: string } }> }>();
    const sessionId = acceptedBody.handoffs[0]?.session.id;
    expect(sessionId).toBeDefined();

    const submittedForApproval = await request(`/api/portal/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Taming CI in a 500-package monorepo",
        abstract: "Revised speaker copy ready for organizer approval.",
      }),
    });
    expect(submittedForApproval.status).toBe(200);

    const response = await request(`/api/events/${eventId}/deliverables`, {
      headers: { cookie: organizerCookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      metrics: { awaitingApproval: number };
      sessionsAwaitingApproval: Array<{
        id: string;
        title: string | null;
        contentStatus: string;
        speakers: Array<{ id: string; name: string }>;
      }>;
    }>();

    expect(payload.metrics.awaitingApproval).toBe(1);
    expect(payload.sessionsAwaitingApproval).toContainEqual({
      id: sessionId,
      title: "Taming CI in a 500-package monorepo",
      contentStatus: "in_review",
      speakers: [{ id: "spk_priya_devflow_2027", name: "Priya Raman" }],
    });
  });

  it("shares attributed file comments with the owner and organizer while refusing another speaker's file and thread", async () => {
    const upload = await request("/api/portal/tasks/tsk_fixture_3/files", {
      method: "POST",
      headers: { cookie: priyaCookie },
      body: pdfUpload("review-copy.pdf"),
    });
    expect(upload.status).toBe(201);
    const { fileId } = await upload.json<{ fileId: string }>();

    const organizerComment = await request(`/api/content/files/${fileId}/comments`, {
      method: "POST",
      headers: { cookie: organizerCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Please add the event title to the opening slide." }),
    });
    expect(organizerComment.status).toBe(201);
    expect(await organizerComment.json()).toMatchObject({
      body: "Please add the event title to the opening slide.",
      author: { name: "Jordan Alvarez", role: "organizer" },
    });

    const speakerComment = await request(`/api/content/files/${fileId}/comments?eventId=${eventId}`, {
      method: "POST",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Updated — the title is now on slide one." }),
    });
    expect(speakerComment.status).toBe(201);

    const ownerThread = await request(`/api/content/files/${fileId}/comments?eventId=${eventId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(ownerThread.status).toBe(200);
    const thread = await ownerThread.json<{
      items: Array<{ id: string; body: string; createdAt: string; author: { name: string; role: string } }>;
    }>();
    expect(thread.items).toHaveLength(2);
    expect(thread.items.map((comment) => comment.author)).toEqual([
      { name: "Jordan Alvarez", role: "organizer" },
      { name: "Priya Raman", role: "speaker" },
    ]);
    expect(thread.items.every((comment) => comment.id.startsWith("cmt_") && !Number.isNaN(Date.parse(comment.createdAt)))).toBe(true);

    expect((await request(`/api/portal/files/${fileId}`, { headers: { cookie: marcusCookie } })).status).toBe(403);
    expect((await request(`/api/content/files/${fileId}/comments?eventId=${eventId}`, { headers: { cookie: marcusCookie } })).status).toBe(403);
    expect((await request(`/api/content/files/${fileId}/comments?eventId=${eventId}`, {
      method: "POST",
      headers: { cookie: marcusCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "I should never reach this thread." }),
    })).status).toBe(403);
  });

  it("requires a matching event before a multi-event speaker can read or write file comments", async () => {
    const database = drizzle(env.DB);
    const [person] = await database
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, priyaCredentials.email));
    expect(person).toBeDefined();
    const suffix = crypto.randomUUID().slice(0, 8);
    const previousEventId = `evt_comment_history_${suffix}`;
    const previousSpeakerId = `spk_comment_history_${suffix}`;
    const previousFileId = `fil_comment_history_${suffix}`;
    await database.insert(events).values({
      id: previousEventId,
      slug: `comment-history-${suffix}`,
      name: "Previous Comment Conference",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      venue: "Portland",
      timezone: "America/Los_Angeles",
    });
    await database.insert(speakers).values({
      id: previousSpeakerId,
      personId: person!.id,
      eventId: previousEventId,
      status: "confirmed",
    });
    await database.insert(files).values({
      id: previousFileId,
      eventId: previousEventId,
      speakerId: previousSpeakerId,
      kind: "deliverable",
      displayName: "previous-event-slides.pdf",
    });

    const commentsPath = `/api/content/files/${previousFileId}/comments`;
    const missingEvent = await request(commentsPath, { headers: { cookie: priyaCookie } });
    expect(missingEvent.status).toBe(400);
    await expect(missingEvent.json()).resolves.toEqual({ error: "speaker_event_required" });

    const activeEventRead = await request(`${commentsPath}?eventId=${eventId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(activeEventRead.status).toBe(403);
    const activeEventWrite = await request(`${commentsPath}?eventId=${eventId}`, {
      method: "POST",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "This event must not reach the previous thread." }),
    });
    expect(activeEventWrite.status).toBe(403);

    const previousEventWrite = await request(`${commentsPath}?eventId=${previousEventId}`, {
      method: "POST",
      headers: { cookie: priyaCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "This comment belongs to the previous event." }),
    });
    expect(previousEventWrite.status).toBe(400);
    await expect(previousEventWrite.json()).resolves.toEqual({ error: "invalid_speaker_event" });
    const previousEventRead = await request(`${commentsPath}?eventId=${previousEventId}`, {
      headers: { cookie: priyaCookie },
    });
    expect(previousEventRead.status).toBe(400);
    await expect(previousEventRead.json()).resolves.toEqual({ error: "invalid_speaker_event" });

    const previousFileDownload = await request(
      `/api/portal/files/${previousFileId}?eventId=${previousEventId}`,
      { headers: { cookie: priyaCookie } },
    );
    expect(previousFileDownload.status).toBe(400);
    await expect(previousFileDownload.json()).resolves.toEqual({ error: "invalid_speaker_event" });

    const organizerThread = await request(commentsPath, { headers: { cookie: organizerCookie } });
    expect(organizerThread.status).toBe(200);
    await expect(organizerThread.json()).resolves.toEqual({ items: [] });
  });
});
