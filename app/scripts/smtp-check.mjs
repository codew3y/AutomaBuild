/**
 * Does the relay accept these credentials?
 *
 * A full webhook round trip is a slow way to discover a typo in a password: it
 * verifies a signature, starts a durable run, calls an API and reshapes the
 * result, all before the one thing you were testing gets a chance to fail.
 * This does the login and nothing else.
 *
 *   npm run smtp:check
 *
 * It never prints the password, and it does not send a message — `verify()`
 * opens the connection, authenticates, and hangs up.
 */

import { createTransport } from 'nodemailer'

const host = process.env.SMTP_HOST
if (host === undefined || host === '') {
  console.error('SMTP_HOST is not set in this window.')
  console.error('The variables are per-window, so a fresh terminal has none of them.')
  process.exit(1)
}

const port = Number(process.env.SMTP_PORT ?? 587)
const user = process.env.SMTP_USER
const pass = process.env.SMTP_PASSWORD ?? ''

console.log(`host     ${host}:${port}`)
console.log(`user     ${user ?? '(not set)'}`)
console.log(`from     ${process.env.SMTP_FROM ?? '(not set)'}`)

// The value is never printed — its shape is, because that is what the common
// mistakes look like: a placeholder left in, or spaces not stripped.
console.log(`password ${pass.length} characters${/\s/.test(pass) ? ', CONTAINS SPACES' : ''}`)

if (pass === '') {
  console.error('\nSMTP_PASSWORD is empty.')
  process.exit(1)
}
if (/^your|password$|example/i.test(pass)) {
  console.error('\nThat looks like the placeholder from the instructions rather than a real password.')
  process.exit(1)
}
if (/\s/.test(pass)) {
  console.error('\nGoogle shows an app password as four groups of four. Remove the spaces.')
  process.exit(1)
}
if (pass.length !== 16) {
  console.error(`\nA Gmail app password is exactly 16 characters; this is ${pass.length}.`)
  console.error('If you are not using Gmail, ignore this and see whether the login below succeeds.')
}

const transporter = createTransport({
  host,
  port,
  secure: process.env.SMTP_SECURE === undefined ? port === 465 : process.env.SMTP_SECURE === 'true',
  ...(user === undefined ? {} : { auth: { user, pass } }),
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
})

try {
  await transporter.verify()
  console.log('\nAccepted. The relay is happy with these credentials.')
  process.exit(0)
} catch (error) {
  const err = error
  console.error(`\nRefused: ${err.message}`)

  if (String(err.message).includes('535')) {
    console.error('\n535 means the username and password were not accepted. Usually one of:')
    console.error('  - the account password was used instead of an App Password')
    console.error('  - the App Password was pasted with its spaces still in it')
    console.error('  - SMTP_USER is a different account from the one that made the App Password')
    console.error('  - the App Password was revoked, or 2-Step Verification was turned off')
    console.error('\nGenerate a fresh one at https://myaccount.google.com/apppasswords')
  }
  process.exit(1)
}
