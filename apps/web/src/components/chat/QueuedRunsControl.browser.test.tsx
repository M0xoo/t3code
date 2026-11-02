import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  command: (async () => ({ _tag: "Success", value: undefined })) as (
    value: unknown,
  ) => Promise<unknown>,
  toast: null as unknown as (toast: unknown) => void,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
  useQuietThreadShell: ((target: unknown) =>
    target === null ? null : { title: "Release lead" }) as never,
}));

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { tasks: [{ id: "task:webhook", title: "PR dispatcher" }] },
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => (value: unknown) => state.command(value)) as never,
}));

vi.mock(import("../ui/toast"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    toastManager: {
      ...original.toastManager,
      add: ((toast: unknown) => {
        state.toast(toast);
        return "toast";
      }) as never,
    },
  };
});

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import "~/index.css";
import { render as renderUi } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.command = async () => ({ _tag: "Success", value: undefined });
  state.toast = () => undefined;
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  timestampFormat: "locale",
  onOpenThread: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("shows who sent a queued message and folds automation and agent prompts", async () => {
  setup();
  const message = (id: string, fields: Record<string, unknown>) => ({
    id,
    role: "user",
    createdAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
    ...fields,
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      [
        "run:automation",
        "GitHub labeled a pull request.\nFollow the runbook.",
        {
          createdBy: "agent",
          scheduledTaskId: "task:webhook",
        },
      ],
      [
        "run:agent",
        "Review finished.",
        {
          createdBy: "agent",
          creationSource: "provider",
          senderThreadId: "thread:lead",
        },
      ],
      [
        "run:server",
        "Continue where you left off.",
        {
          createdBy: "agent",
          creationSource: "server",
        },
      ],
    ].map(([runId, text, fields]) => ({
      run: { id: runId, userMessageId: `${runId}:message` },
      text,
      attachments: [],
      message: message(`${runId}:message`, { text, ...(fields as object) }),
    })),
  };
  const onOpenThread = vi.fn();
  await using _screen = await renderQueue({ onOpenThread });

  const automation = page.getByRole("button", { name: /PR dispatcher/ });
  await expect.element(automation).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText(/Follow the runbook/)).not.toBeInTheDocument();
  await automation.click();
  await expect.element(page.getByText(/Follow the runbook/)).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Open automation" })).toBeInTheDocument();

  await expect.element(page.getByRole("button", { name: /Release lead/ })).toBeVisible();
  await page.getByRole("button", { name: "Open thread" }).click({ force: true });
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("thread:lead");

  await expect.element(page.getByText("Sent by T3 Code")).toBeVisible();
  await expect.element(page.getByText("Continue where you left off.")).toBeVisible();
});

it("stays inside the timeline scroller instead of growing the chat column", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Later",
        attachments: [],
      },
    ],
  };
  // Mirrors ChatView: a scrollable column, a positioned wrapper, then a non-positioned scroller.
  await using screen = await renderUi(
    <div data-testid="column" style={{ height: 200, overflowY: "auto" }}>
      <div style={{ position: "relative", height: "100%" }}>
        <div style={{ height: "100%", overflowY: "auto" }}>
          <div style={{ height: 1000 }} />
          <QueuedRunsControl {...baseProps} />
        </div>
      </div>
    </div>,
  );
  await expect.element(page.getByText("Later", { exact: true })).toBeInTheDocument();
  const column = screen.getByTestId("column").element();
  expect(column.scrollHeight).toBe(column.clientHeight);
});

function threeQueued() {
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: ["first", "second", "third"].map((name) => ({
      run: { id: `run:${name}`, userMessageId: `message:${name}` },
      text: `${name} follow-up`,
      attachments: [],
    })),
  };
}

async function shownOrder() {
  const rows = await page.getByRole("listitem").all();
  return rows.map((row) => row.element().textContent?.match(/(\w+) follow-up/)?.[1]);
}

it("moves a queued message up or down at once and sends the reorder", async () => {
  setup();
  threeQueued();
  const command = vi.fn(async (_value: unknown) => ({ _tag: "Success", value: undefined }));
  state.command = command;
  await using _screen = await renderQueue();

  const up = page.getByRole("button", { name: "Move up in queue", exact: true });
  const down = page.getByRole("button", { name: "Move down in queue", exact: true });
  await expect.element(up.nth(0)).toBeDisabled();
  await expect.element(down.nth(2)).toBeDisabled();

  await up.nth(2).click();
  expect(command).toHaveBeenLastCalledWith({
    environmentId: "environment:test",
    input: { threadId: "thread:test", runId: "run:third", beforeRunId: "run:second" },
  });
  await expect.poll(shownOrder).toEqual(["first", "third", "second"]);

  await down.nth(0).click();
  expect(command).toHaveBeenLastCalledWith({
    environmentId: "environment:test",
    input: { threadId: "thread:test", runId: "run:first", beforeRunId: "run:second" },
  });
  await expect.poll(shownOrder).toEqual(["third", "first", "second"]);
});

it("puts a refused move back and says why", async () => {
  setup();
  threeQueued();
  state.command = async () => ({
    _tag: "Failure",
    cause: Cause.fail(new Error("Run run:second is not queued.")),
  });
  const toast = vi.fn();
  state.toast = toast;
  await using _screen = await renderQueue();

  await page.getByRole("button", { name: "Move down in queue", exact: true }).nth(1).click();
  await expect.poll(shownOrder).toEqual(["first", "second", "third"]);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "Could not move the queued message",
      description: "Run run:second is not queued.",
    }),
  );
});

it("offers no moves for a single queued message", async () => {
  setup();
  threeQueued();
  const workflow = state.workflow as { queuedRuns: ReadonlyArray<unknown> };
  state.workflow = { ...workflow, queuedRuns: workflow.queuedRuns.slice(0, 1) };
  await using _screen = await renderQueue();

  await expect
    .element(page.getByRole("button", { name: "Edit queued message", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Move up in queue", exact: true }))
    .not.toBeInTheDocument();
});
