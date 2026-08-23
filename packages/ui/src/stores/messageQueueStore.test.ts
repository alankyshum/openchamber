import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  normalizePersistedQueueMessages,
  parseMessageQueueKey,
  useMessageQueueStore,
} from "./messageQueueStore"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("bounds each queue to the newest 20 messages", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 25; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-5")
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markSending(target, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]?.content).toBe("second")

    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markSending(target, inFlight.id)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test("admitted and pending messages are never locally sendable or cleared", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    const pending = store.addToQueue(target, { content: "pending", admissionState: 'pending-admission' })
    const admitted = store.addToQueue(target, { content: "admitted", admissionState: 'admitted' })
    expect(store.getSendableQueue(target)).toHaveLength(0)
    store.clearQueue(target)
    const remaining = store.getQueueForTarget(target)
    expect(remaining.map((message) => message.id)).toEqual([pending, admitted])
  })

  test("v2 migration marks legacy queued items local", () => {
    const migrated = migrateMessageQueueState({ queuedMessages: { key: [{ id: 'q', content: 'text', createdAt: 1 }] } }, 2)
    expect(migrated.queuedMessages?.key?.[0]?.admissionState).toBe('local')
  })

  test("migration does not turn an interrupted admission into a resend", () => {
    const migrated = migrateMessageQueueState({ queuedMessages: { key: [{ id: 'q', content: 'text', createdAt: 1, admissionState: 'pending-admission' }] } }, 3)
    expect(migrated.queuedMessages?.key?.[0]?.admissionState).toBe('admission-unknown')
  })

  test("same-version hydration normalizes pending items and expires old admitted history", () => {
    const hydrated = normalizePersistedQueueMessages({ key: [
      { id: 'pending', content: 'keep', createdAt: Date.now(), admissionState: 'pending-admission' },
      { id: 'old', content: 'drop', createdAt: 1, admissionState: 'admitted' },
    ]})
    expect(hydrated.key?.map((message) => [message.id, message.admissionState])).toEqual([['pending', 'admission-unknown']])
  })

  test("bounds admitted history without evicting recoverable messages", () => {
    const recoverable = Array.from({ length: 20 }, (_, index) => ({
      id: `local-${index}`, content: `local-${index}`, createdAt: Date.now(), admissionState: 'admission-failed' as const,
    }))
    const admitted = Array.from({ length: 30 }, (_, index) => ({
      id: `admitted-${index}`, content: `admitted-${index}`, createdAt: Date.now(), admissionState: 'admitted' as const,
    }))
    const normalized = normalizePersistedQueueMessages({ key: [...recoverable, ...admitted] }).key ?? []
    expect(normalized.filter((message) => message.admissionState === 'admission-failed')).toHaveLength(20)
    expect(normalized.filter((message) => message.admissionState === 'admitted')).toHaveLength(20)
  })

  test("settling B never changes pending A data", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const attachment = { id: 'a-file', file: new File([], 'a.txt'), dataUrl: 'data:text/plain;base64,a', mimeType: 'text/plain', filename: 'a.txt', size: 1, source: 'local' as const }
    const store = useMessageQueueStore.getState()
    const a = store.addToQueue(target, { content: 'A', admissionState: 'pending-admission', clientMessageId: 'msg_a', attachments: [attachment], sendConfig: { providerID: 'p', modelID: 'm' } })
    const b = store.addToQueue(target, { content: 'B', admissionState: 'pending-admission', clientMessageId: 'msg_b', attachments: [attachment], sendConfig: { providerID: 'p', modelID: 'm' } })

    useMessageQueueStore.getState().markAdmissionLocal(target, b)
    let queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingA = queue.find((message) => message.id === a)
    expect(pendingA?.admissionState).toBe('pending-admission')
    expect(pendingA?.attachments).toEqual([attachment])
    expect(pendingA?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })

    useMessageQueueStore.getState().markAdmissionLocal(target, a)
    expect(useMessageQueueStore.getState().getSendableQueue(target).map((message) => message.id)).toEqual([a, b])
    useMessageQueueStore.getState().markAdmissionPending(target, a, 'msg_a')

    useMessageQueueStore.getState().markAdmissionPending(target, b, 'msg_b')
    useMessageQueueStore.getState().markAdmissionFailed(target, b)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingAAfterFailedB = queue.find((message) => message.id === a)
    expect(pendingAAfterFailedB?.admissionState).toBe('pending-admission')
    expect(pendingAAfterFailedB?.attachments).toEqual([attachment])
    expect(pendingAAfterFailedB?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })
    expect(queue.find((message) => message.id === b)?.admissionState).toBe('admission-failed')

    useMessageQueueStore.getState().markAdmissionPending(target, b, 'msg_b')
    useMessageQueueStore.getState().markAdmissionUnknown(target, b)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingAAfterUnknownB = queue.find((message) => message.id === a)
    expect(pendingAAfterUnknownB?.admissionState).toBe('pending-admission')
    expect(pendingAAfterUnknownB?.attachments).toEqual([attachment])
    expect(pendingAAfterUnknownB?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })

    useMessageQueueStore.getState().markAdmissionLocal(target, a)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue.map((message) => message.id)).toEqual([a, b])
    expect(queue.map((message) => message.admissionState)).toEqual(['local', 'admission-unknown'])
    expect(queue.find((message) => message.id === a)?.attachments).toEqual([attachment])
    expect(queue.find((message) => message.id === a)?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })
  })
})
