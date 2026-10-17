// GoodDoc Control Panel integration (@gooddoc/gd-plugin).
//
// - <GoodDocProvider> mounts the panel (floating launcher + Ctrl+G) and the bridge below.
// - useGoodDocPatient(appointment) shares the patient, appointment and full consultation on screen
//   (see context.ts); the panel can also request any consultation with host.getConsultation.
// - The bridge answers the panel: ambient notes are saved to the chart, follow-up requests
//   create appointments, "visit summary" reads recent appointments, "Open visits" navigates.
//
// Configured by VITE_GD_API_KEY (see .env.example). Without it the integration is
// switched off and the app runs exactly as before.
//
// Debugging: everything is logged to the console as [GoodDoc] (failures as errors/warnings).
// Status, config, messages, requests and the last context are in window.__DENTALCARE__.gooddoc.

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  GDPluginProvider,
  useGDPlugin,
  usePluginContext,
  usePluginMessage,
  usePluginRequestHandler,
} from '@gooddoc/gd-plugin/react'
import type { GDPluginError, RequestHandler } from '@gooddoc/gd-plugin'
import type { Appointment } from '../types'
import { emptyNote } from '../data/seed'
import { formatDate, todayISO, toISODate } from '../lib/format'
import { newAppointmentId, newSessionId } from '../lib/ids'
import { debugState, logger, mask } from '../lib/debug'
import { useDemoStore } from '../store/DemoStore'
import { fromAmbientNote, mergeAmbientNote } from './note'
import { buildContext, sharedConsultation } from './context'

const log = logger('GoodDoc')

const apiKey = import.meta.env.VITE_GD_API_KEY
export const GOODDOC_ENABLED = Boolean(apiKey)
const apiBaseUrl = 'https://gd-plugin-api.vizru-aix.workers.dev'
const panelUrl = 'https://gd-plugin-panel.vizru-aix.workers.dev'
const devMode = new URLSearchParams(location.search).get('dev') !== '0';
Object.assign(debugState.gooddoc, { enabled: GOODDOC_ENABLED, apiBaseUrl, panelUrl, apiKey: mask(apiKey), origin: location.origin })

// The key is baked in at build time, so a CI build without it ships with GoodDoc off. Say so.
if (!GOODDOC_ENABLED) log.warn('Off: VITE_GD_API_KEY was not set when this build was made (set it as a build variable and rebuild).')
else log.log(`Starting with key ${mask(apiKey)} → API ${apiBaseUrl}, panel ${panelUrl}, origin ${location.origin}`)

// What to check for each SDK error code.
const HINTS: Record<string, string> = {
  INVALID_API_KEY: 'The key is malformed, unknown or revoked. Check VITE_GD_API_KEY.',
  ORIGIN_NOT_ALLOWED: `This page's origin (${location.origin}) is not registered for the key. Add it to ALLOWED_ORIGINS in the GoodDoc API.`,
  NETWORK: `The GoodDoc API (${apiBaseUrl}) is unreachable, or blocked by CSP connect-src / an ad blocker.`,
  HANDSHAKE_TIMEOUT: `The panel (${panelUrl}) did not load in its iframe. Check CSP frame-src, X-Frame-Options and that the panel is deployed.`,
}

// The appointment currently on screen. Ambient notes arriving for this patient are filed against it.
let activeAppointment: Appointment | null = null

type AmbientNoteMessage = { sessionId?: string; patientId?: string; patientName?: string; note?: unknown }
type FollowUpRequest = { patientId?: string; type?: string; inMonths?: number }

export function GoodDocProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  if (!GOODDOC_ENABLED) return <>{children}</>

  return (
    <GDPluginProvider
      apiKey={apiKey!}
      apiBaseUrl={apiBaseUrl}
      panelUrl={panelUrl}
      hotkey="ctrl+g"
      // The panel speaks in /patients/:id paths; this app lists a patient's visits on the appointments page.
      onNavigateRequest={(path) => {
        const patient = /^\/patients\/([^/?#]+)/.exec(path)
        if (patient) {
          const to = `/appointments?q=${encodeURIComponent(decodeURIComponent(patient[1]))}`
          log.log(`Panel navigation ${path} → ${to}`)
          navigate(to)
        } else if (path.startsWith('/appointments')) {
          log.log(`Panel navigation → ${path}`)
          navigate(path)
        } else {
          log.warn(`Panel navigation refused: no route for ${path}`)
          return false
        }
      }}
      onReady={() => log.log('Connected: key validated and panel handshake complete')}
      onError={(e: GDPluginError) => {
        debugState.setGoodDocError(e.code, e.message)
        log.error(`Control Panel unavailable (${e.code}): ${e.message}. ${HINTS[e.code] ?? ''}`, e)
      }}      devMode={devMode}
    >
      <GoodDocBridge />
      {children}
    </GDPluginProvider>
  )
}

/** Best appointment to file a patient's note against: today's, else the most recent past, else the next one. */
function appointmentFor(appointments: Appointment[], patientId: string): Appointment | undefined {
  const today = todayISO()
  const mine = appointments
    .filter((a) => a.patientId === patientId && a.status !== 'Cancelled')
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
  return mine.find((a) => a.date === today) ?? mine.find((a) => a.date < today) ?? mine.at(-1)
}

/** Wraps a request handler so every call, result and failure is logged and recorded. */
function traced(method: string, handler: RequestHandler): RequestHandler {
  return async (params) => {
    log.log(`Request ${method}`, params)
    try {
      const result = await handler(params)
      debugState.recordRequest({ method, params, ok: true })
      log.log(`Request ${method} answered`, result)
      return result
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      debugState.recordRequest({ method, params, ok: false, error })
      log.error(`Request ${method} failed: ${error}`, params)
      throw e
    }
  }
}

function GoodDocBridge() {
  const { appointments, records, saveAppointment, getRecord, saveRecord, notify } = useDemoStore()
  const gd = useGDPlugin()
  // GoodDoc ambient session → the appointment that was open when recording started.
  const sessions = useRef(new Map<string, string>())

  useEffect(() => {
    debugState.gooddoc.status = gd.status
    log.log(`Status: ${gd.status}`)
    if (gd.status === 'error' && gd.error) {
      // Also caught by onError; this keeps the status consistent if the SDK reports it only via status.
      debugState.setGoodDocError(gd.error.code, gd.error.message)
    }
  }, [gd.status, gd.error])

  useEffect(() => {
    log.log(`Panel ${gd.isOpen ? 'opened' : 'closed'}`)
  }, [gd.isOpen])

  // Every message from the panel, for the debug log.
  usePluginMessage('*', (data, msg) => {
    debugState.recordMessage(msg.topic, data)
    log.log(`Message ${msg.topic}`, data)
  })

  usePluginMessage<{ sessionId?: string; patientId?: string }>('ambient.started', ({ sessionId, patientId }) => {
    if (!sessionId) return log.warn('ambient.started without a sessionId; its note will be filed by patient instead')
    if (!activeAppointment) return log.warn(`Ambient session ${sessionId} started with no appointment open; its note will be filed by patient`)
    if (activeAppointment.patientId !== patientId) {
      return log.warn(`Ambient session ${sessionId} is for ${patientId}, but ${activeAppointment.patientId} is on screen; its note will be filed by patient`)
    }
    sessions.current.set(sessionId, activeAppointment.sessionId)
    log.log(`Ambient session ${sessionId} linked to ${activeAppointment.appointmentId}`)
  })

  usePluginMessage<{ sessionId?: string; message?: string }>('ambient.error', ({ sessionId, message }) =>
    log.error(`Ambient session ${sessionId ?? '?'} failed in the panel: ${message ?? 'no details'}`),
  )

  // The clinician reviewed, confirmed and saved the note in the panel: file it in the chart.
  usePluginMessage<AmbientNoteMessage>('ambient.note', async (data) => {
    const patientId = data.patientId ?? ''
    if (!patientId) log.warn('ambient.note without a patientId', data)
    if (!data.note || typeof data.note !== 'object') log.warn('ambient.note has no note object; nothing will be filled in', data.note)

    const started = data.sessionId ? sessions.current.get(data.sessionId) : undefined
    const bySession = appointments.find((a) => a.sessionId === started)
    const onScreen = activeAppointment?.patientId === patientId ? activeAppointment : undefined
    const target = bySession ?? onScreen ?? appointmentFor(appointments, patientId)
    const who = data.patientName || target?.patientName || patientId || 'this patient'
    if (!target) {
      log.error(`ambient.note for ${patientId || '(no patient)'}: no appointment to file it against`, { known: appointments.map((a) => a.patientId) })
      return notify(`GoodDoc note for ${who} received, but there is no appointment to file it against.`, 'error')
    }
    log.log(`ambient.note for ${who} → ${target.appointmentId} (matched by ${bySession ? 'ambient session' : onScreen ? 'appointment on screen' : 'patient’s latest appointment'})`)

    try {
      const existing = await getRecord(target)
      const { note, updated } = mergeAmbientNote(existing?.note ?? emptyNote(), fromAmbientNote(data.note))
      if (updated.length === 0) {
        log.log(`ambient.note for ${target.appointmentId}: no fields differ from the chart, nothing saved`)
        return notify(`GoodDoc note for ${who} matches the chart. Nothing to update.`)
      }
      log.log(`ambient.note for ${target.appointmentId}: updating ${updated.join(', ')}`)
      const ok = await saveRecord(target, {
        sessionId: target.sessionId,
        patientId: target.patientId,
        patientName: target.patientName,
        note,
      })
      if (ok) notify(`GoodDoc note saved to ${who}’s chart (${target.appointmentId}) · ${updated.length} field${updated.length > 1 ? 's' : ''} updated`)
      else log.error(`ambient.note for ${target.appointmentId}: save failed (see the API error above)`)
    } catch (e) {
      log.error(`ambient.note for ${target.appointmentId}: could not load or save the record`, e)
      notify(`Could not save the GoodDoc note: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    }
  })

  // "Book follow-up" in the panel. There is no appointment API yet, so this is kept for the session.
  usePluginMessage<FollowUpRequest>('appointment.requested', ({ patientId = '', type, inMonths = 6 }) => {
    if (!patientId) log.warn('appointment.requested without a patientId; booking anyway')
    const last = appointmentFor(appointments, patientId) ?? appointments.find((a) => a.patientId === patientId)
    if (!last) log.warn(`appointment.requested: no existing appointment for ${patientId}; patient name and dentist unknown`)
    const date = new Date()
    date.setMonth(date.getMonth() + inMonths)
    const appointment: Appointment = {
      appointmentId: newAppointmentId(appointments),
      sessionId: newSessionId(),
      patientId,
      patientName: last?.patientName ?? '',
      date: toISODate(date),
      time: '09:00',
      type: type === 'recall' ? `${inMonths}-month recall` : type || 'Follow-up',
      dentist: last?.dentist ?? '',
      status: 'Scheduled',
    }
    saveAppointment(appointment)
    notify(`Follow-up booked for ${appointment.patientName || patientId} on ${formatDate(appointment.date)} (${appointment.appointmentId})`)
  })

  usePluginMessage<{ patientId?: string; kind?: string }>('report.requested', ({ kind }) =>
    notify(`GoodDoc ${kind ? kind.replace(/-/g, ' ') + ' ' : ''}report requested. It will appear in GoodDoc when ready.`),
  )

  // "Send summary to chart". The summary is built from this app's own visit list, so there's nothing new to store.
  usePluginMessage<{ items?: unknown[] }>('summary.ready', ({ items }) =>
    notify(`GoodDoc visit summary received (${items?.length ?? 0} visit${items?.length === 1 ? '' : 's'})`),
  )

  // "Prepare visit summary": the patient's visits, newest first, with each visit's
  // complaint and assessment when its consultation has been loaded.
  usePluginRequestHandler(
    'host.getRecentActivity',
    traced('host.getRecentActivity', (params) => {
      const { patientId } = (params ?? {}) as { patientId?: string }
      if (!patientId) log.warn('host.getRecentActivity without a patientId; returning nothing')
      const visits = appointments
        .filter((a) => a.patientId === patientId)
        .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
        .slice(0, 10)
      if (patientId && visits.length === 0) log.warn(`host.getRecentActivity: no appointments for ${patientId}`)
      return visits.map((a) => {
        const state = records[a.sessionId]
        const note = state?.status === 'ready' ? state.record?.note : undefined
        const clinical = [note?.chiefComplaint, note?.assessment].filter(Boolean).join(' — ')
        return { title: a.type, date: formatDate(a.date), detail: [`${a.status} · ${a.appointmentId}`, clinical].filter(Boolean).join(' · ') }
      })
    }),
  )

  // Full consultation(s) on demand, in the same shape as the context's `consultation`:
  //   { appointmentId } or { sessionId } → one; { patientId } → all of that patient's, newest first.
  usePluginRequestHandler(
    'host.getConsultation',
    traced('host.getConsultation', async (params) => {
      const { appointmentId, sessionId, patientId } = (params ?? {}) as { appointmentId?: string; sessionId?: string; patientId?: string }
      const load = async (a: Appointment) => {
        try {
          const record = await getRecord(a)
          return { appointment: { id: a.appointmentId, ...a }, consultation: sharedConsultation(a, { status: 'ready', record }) }
        } catch (e) {
          log.error(`host.getConsultation: could not load ${a.appointmentId}`, e)
          return { appointment: { id: a.appointmentId, ...a }, consultation: sharedConsultation(a, { status: 'error', message: e instanceof Error ? e.message : 'unknown error' }) }
        }
      }
      if (appointmentId || sessionId) {
        const a = appointments.find((x) => x.appointmentId === appointmentId || x.sessionId === sessionId)
        if (!a) throw new Error(`No appointment ${appointmentId ?? sessionId}`)
        return load(a)
      }
      if (patientId) {
        const mine = appointments.filter((a) => a.patientId === patientId).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
        if (mine.length === 0) log.warn(`host.getConsultation: no appointments for ${patientId}`)
        return Promise.all(mine.map(load))
      }
      throw new Error('Pass appointmentId, sessionId or patientId')
    }),
  )

  return null
}

function useGoodDocPatientLive(appointment: Appointment | undefined) {
  const { appointments, records } = useDemoStore()
  const context = appointment ? buildContext(appointment, appointments, records[appointment.sessionId]) : null
  const key = JSON.stringify(context)
  // Re-sent whenever the appointment, visit list or saved consultation changes (the SDK diffs by value).
  usePluginContext(context)
  useEffect(() => {
    debugState.gooddoc.lastContext = context
    if (context) log.log('Context sent to panel', context)
    else log.log('Context cleared')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    activeAppointment = appointment ?? null
    return () => {
      if (activeAppointment?.sessionId === appointment?.sessionId) activeAppointment = null
    }
  }, [appointment])
}

function useGoodDocLive() {
  const gd = useGDPlugin()
  // A failed connection (bad key, origin not registered, GoodDoc unreachable) hides GoodDoc UI.
  return { enabled: gd.status !== 'error' && gd.status !== 'destroyed', ready: gd.isReady, isOpen: gd.isOpen, show: gd.show }
}

const disabled = { enabled: false, ready: false, isOpen: false, show: () => {} }

// Chosen once at load, so hook order never changes between renders.
/** Share the on-screen patient, appointment and full consultation with the panel while the calling page is mounted. */
export const useGoodDocPatient: (appointment: Appointment | undefined) => void = GOODDOC_ENABLED ? useGoodDocPatientLive : () => {}
/** Panel status and controls; `enabled` is false when GoodDoc isn't configured. */
export const useGoodDoc: () => typeof disabled = GOODDOC_ENABLED ? useGoodDocLive : () => disabled
