/**
 * The flow the editor opens with, and the per-kind schemas.
 *
 * It used to contain a deliberate validation error and a branch, so that the
 * validation panel had something to show on first load. That made sense while
 * nothing could run. It stopped making sense the moment Publish did something:
 * pressing it on a fresh editor produced four errors, because the engine runs
 * a linear chain and the sample was branched. The first thing anyone did with
 * the finished product was watch it refuse its own example.
 *
 * The default is now a flow that publishes and runs: a webhook arrives, an API
 * is called, the two are reshaped, and the result is emailed. The branched
 * version is kept as `BRANCHED_SAMPLE` for the validation tests, which are
 * what actually needed it.
 */

import type { FlowGraph } from './core/graph.ts'
import type { RunRecord } from './core/run.ts'

/**
 * What each AI task is called.
 *
 * These are n8n's own node names, because that is what someone arriving from
 * either product will be looking for. n8n ships a separate node per task —
 * Text Classifier, Information Extractor, Summarization Chain, Basic LLM Chain
 * — while Zapier has one AI action whose event you choose inside it. This
 * follows Zapier's shape, since there is one step kind here, and borrows
 * n8n's vocabulary for the tasks themselves.
 *
 * `write` has no n8n equivalent; the name is Zapier's template category.
 */
/**
 * The providers a credential can be saved for.
 *
 * The same list the AI step's `provider` menu offers, named once: a
 * credential saved for a provider the step cannot select would never be
 * offered to anything.
 */
export const AI_PROVIDERS = [
  'groq',
  'openai',
  'openrouter',
  'together',
  'cerebras',
  'gemini',
] as const

export const AI_TASK_LABELS: Record<string, string> = {
  summarize: 'Summarization',
  classify: 'Text Classifier',
  extract: 'Information Extractor',
  write: 'Write',
  custom: 'LLM Chain',
}

/** A real line break, for a placeholder that has to show one. */
const FIELD_LINE_BREAK = String.fromCharCode(10)

export const STEP_KINDS = ['http', 'ai', 'transform', 'branch', 'email'] as const

export interface StepSchema {
  readonly fields: readonly string[]
  readonly required?: readonly string[]
  readonly label?: string
  /**
   * Fields that need a textarea rather than a single line.
   *
   * The schema decides, not the input component. Guessing from the field name
   * works right up until a step has a `body` that is a URL fragment, and then
   * the guess is wrong in a way nobody can configure their way out of.
   */
  readonly multiline?: readonly string[]
  /**
   * Fields with a fixed set of answers, rendered as a menu.
   *
   * A method is one of five things and a payload type one of three. Typed into
   * a text field, they are five and three ways to make a typo that surfaces
   * only as a failed run — `POSt` is not a method, and nothing says so until
   * the request goes out.
   */
  readonly choices?: Readonly<Record<string, readonly string[]>>
  /**
   * What each choice is called on screen.
   *
   * The stored value is an identifier and has to stay one — a published
   * flow holds it, and renaming it would break every flow that used it.
   * What the menu *shows* is a different question, and this is the answer
   * to it.
   */
  readonly choiceLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /**
   * Fields that only apply for certain values of another field.
   *
   * A Text Classifier needs categories and a Summarization does not, and
   * showing every field for every task means most of the form is noise
   * whatever you are doing. Both products hide what does not apply — n8n
   * by shipping a separate node per task, Zapier by swapping the form when
   * the action event changes. There is one step kind here, so the form
   * does it.
   *
   * A hidden field keeps whatever it holds. Clearing it would throw away a
   * list of categories because someone looked at Summarization for a
   * moment, and a task ignores the fields it does not read anyway.
   */
  /**
   * Fields whose options come from the server rather than the schema.
   *
   * A credential list is not something a schema can hold: it is per
   * tenant, it changes without a deploy, and the value stored in the flow
   * is an id while the thing a person recognises is a name. The schema
   * names the source; the editor fetches it and does the matching.
   */
  readonly optionsFrom?: Readonly<Record<string, 'credentials'>>
  readonly showWhen?: Readonly<
    Record<string, { readonly field: string; readonly is: readonly string[] }>
  >
  /**
   * A friendlier name than the config key.
   *
   * `replyTo` is what the handler wants and "reply to" is what it is called.
   * Only the display changes; the key written into the flow is unchanged.
   */
  readonly labels?: Readonly<Record<string, string>>
  /**
   * A line under the field saying what goes in it.
   *
   * These carry the things that are otherwise only discoverable by failing:
   * that headers are one per line, that a body must be valid JSON unless the
   * payload type says otherwise, which words a condition accepts.
   */
  readonly hints?: Readonly<Record<string, string>>
  /** Placeholder text, for a field whose shape is easier shown than described. */
  readonly placeholders?: Readonly<Record<string, string>>
}

/**
 * The fields that apply, given what the step is currently set to.
 *
 * A field with no `showWhen` always applies. One with a condition applies only
 * when the field it depends on holds one of the listed values — and when that
 * field is unset, the schema's own default for it decides, so a step dropped
 * on the canvas shows the right form before anything is chosen.
 */
export function visibleFields(
  schema: StepSchema | undefined,
  data: Record<string, unknown>,
): readonly string[] {
  const all = schema?.fields ?? []
  const conditions = schema?.showWhen
  if (conditions === undefined) return all

  return all.filter((field) => {
    const rule = conditions[field]
    if (rule === undefined) return true
    const current = String(data[rule.field] ?? '')
    // Unset means the step has not been configured yet. The first choice in
    // the menu is what it will send, so that is what decides.
    const effective = current === '' ? (schema?.choices?.[rule.field]?.[0] ?? '') : current
    return rule.is.includes(effective)
  })
}

export const SCHEMAS: Record<string, StepSchema> = {
  trigger: {
    // Was `event`, which nothing read: it was declared here, shown in the
    // setup dialog, saved into every published flow, and consulted by no code
    // anywhere. A field that does nothing is worse than a missing one, because
    // people fill it in and then reason about a flow as though it mattered.
    //
    // Replaced with the one input a webhook trigger actually has, which is
    // also the only one Zapier's Catch Hook offers: a path into the body, for
    // when the interesting part is nested inside a wrapper.
    fields: ['childKey'],
    label: 'Trigger',
    labels: { childKey: 'pick off a child key' },
    placeholders: { childKey: 'data.order' },
    hints: {
      childKey:
        'Optional. Leave empty to use the whole webhook body. Set it to a path ' +
        'like data.order and the step outputs just that part, so later steps can ' +
        'say {{ trigger.body.id }} instead of {{ trigger.body.data.order.id }}.',
    },
  },

  http: {
    fields: ['url', 'method', 'auth', 'headers', 'payload', 'body'],
    required: ['url'],
    label: 'HTTP request',
    multiline: ['headers', 'body'],
    choices: {
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      payload: ['json', 'form', 'raw'],
    },
    labels: { payload: 'payload type' },
    placeholders: {
      url: 'https://…  or  {{ steps.x.output.url }}',
      auth: 'Bearer {{ steps.login.output.token }}',
      headers: 'Accept: application/json',
      body: '{ "total": {{ steps.order.output.total }} }',
    },
    hints: {
      auth:
        'Optional. Write it as the header does: "Bearer <token>", or ' +
        '"Basic user:password" — the base64 is done for you.',
      headers: 'One per line, as "Name: value". Blank lines and # comments are ignored.',
      payload:
        'json validates the body and sends it as application/json. form turns ' +
        'name=value lines into a form post. raw sends exactly what you typed.',
      body: 'Ignored on GET, HEAD and DELETE.',
    },
  },

  transform: {
    fields: ['template'],
    required: ['template'],
    label: 'Transform',
    multiline: ['template'],
    hints: {
      template:
        'A JSON document. Values may be references, and a value that is only a ' +
        'reference keeps its type — 42 stays a number.',
    },
  },

  branch: {
    fields: ['condition'],
    required: ['condition'],
    label: 'Branch',
    placeholders: { condition: '{{ steps.order.output.total }} >= 100' },
    hints: {
      condition:
        'Compare with = != > < >= <=, or with the words contains, starts with, ' +
        'ends with, is in, exists (and their "does not" forms). Join with and / or.',
    },
  },

  ai: {
    // Ordered as the work is done, which is how both Zapier and n8n order it:
    // what kind of job, what to do, what to give back, then how to behave, then
    // the knobs almost nobody touches.
    fields: [
      'task',
      'prompt',
      'categories',
      'allowMultiple',
      'noMatch',
      'outputFields',
      'system',
      'model',
      'provider',
      'maxTokens',
      'temperature',
      'credential',
      'apiKey',
    ],
    required: ['prompt', 'model'],
    // Not a name I made up: see AI_TASK_LABELS.
    label: 'AI',
    multiline: ['prompt', 'outputFields', 'system'],
    choices: {
      task: ['summarize', 'classify', 'extract', 'write', 'custom'],
      allowMultiple: ['single', 'multiple'],
      noMatch: ['other', 'fail'],
      provider: AI_PROVIDERS,
    },
    optionsFrom: { credential: 'credentials' },
    choiceLabels: {
      task: AI_TASK_LABELS,
      allowMultiple: { single: 'one category', multiple: 'any that apply' },
      noMatch: { other: 'answer other', fail: 'fail the step' },
    },
    // The three classification fields mean nothing for the other tasks.
    showWhen: {
      categories: { field: 'task', is: ['classify'] },
      allowMultiple: { field: 'task', is: ['classify'] },
      noMatch: { field: 'task', is: ['classify'] },
    },
    labels: {
      outputFields: 'output fields',
      allowMultiple: 'how many categories',
      noMatch: 'when nothing matches',
      credential: 'credential',
      apiKey: 'api key (advanced)',
      maxTokens: 'max tokens',
    },
    placeholders: {
      prompt: 'Classify this support message: {{ trigger.body.message }}',
      outputFields: [
        'sentiment: text — positive, negative or neutral',
        'urgent: boolean',
      ].join(FIELD_LINE_BREAK),
      categories: [
        'billing — invoices, refunds, card details',
        'bug — something in the product is not working',
        'feature — asking for something that does not exist yet',
      ].join(FIELD_LINE_BREAK),
      model: 'llama-3.1-8b-instant',
      apiKey: 'usually leave empty',
      system: 'left empty, the task above supplies one',
    },
    hints: {
      task:
        'Sets how the model is told to behave — a model asked to classify with no ' +
        'further instruction writes a paragraph explaining itself instead. Pick ' +
        'custom if your prompt already says everything.',
      prompt:
        'Plain text. References are substituted and escaped for you, so a quote or ' +
        'a newline in the data cannot break the request.',
      outputFields:
        'One per line, as name: type — description. Types: text, number, boolean, ' +
        'list. Each becomes its own value, so a later step can read ' +
        '{{ steps.ai.output.sentiment }} and a branch can compare it. Add ? after ' +
        'a name to let the model leave it out. Leave this empty and you get one ' +
        'combined answer in output.text instead.',
      categories:
        'One per line, as name — description. The description is what tells the model ' +
        'what a category means, which matters when the name does not say so. The answer ' +
        'arrives as {{ steps.ai.output.category }}.',
      allowMultiple:
        'One category, or any that apply. Choosing many puts a list in ' +
        'output.categories instead of a single output.category.',
      noMatch:
        'A model given five categories will sometimes answer with a sixth. Either that ' +
        'becomes other, for a branch to handle, or the step fails.',
      system: 'Optional. Overrides the task’s own instruction when you write one.',
      model: 'Whatever the provider calls it. groq: llama-3.1-8b-instant is free and fast.',
      provider: 'Defaults to groq. All of these speak the same protocol.',
      credential:
        'A key you saved once, under Credentials on the flow list. Only the ones for ' +
        'this provider are offered. Leave it empty and the server uses the provider ' +
        'variable in its own environment instead.',
      apiKey:
        'Optional. The server reads the provider’s usual variable on its own — ' +
        'GROQ_API_KEY for groq, OPENAI_API_KEY for openai, and so on. Set this ' +
        'only to point at a different one, as env:MY_OTHER_KEY. Never the key ' +
        'itself: it would be saved into the published flow.',
      maxTokens: 'Optional. Caps the length of the reply.',
      temperature: 'Optional. 0 is repeatable, 1 is loose. Leave empty for the model default.',
    },
  },

  email: {
    // `from` is optional and falls back to the server's SMTP_FROM. It is listed
    // first because it is the field someone changes once per flow and then
    // leaves alone, unlike the ones below it.
    //
    // `cc` and `replyTo` were supported by the handler from the start and
    // simply never offered here, so the only way to reach them was to publish
    // a flow by hand.
    fields: ['from', 'to', 'cc', 'replyTo', 'subject', 'body'],
    required: ['to', 'body'],
    label: 'Send email',
    multiline: ['body'],
    labels: { replyTo: 'reply to' },
    placeholders: { to: 'ada@example.com, grace@example.com' },
    hints: {
      from: 'Optional. Falls back to the server’s configured sender.',
      to: 'One or more addresses, separated by commas.',
      replyTo: 'Optional. Where replies go, when that is not the sender.',
    },
  },
}

/**
 * What a brand-new flow starts as.
 *
 * A trigger and nothing else. Not an empty canvas: every flow must begin at a
 * trigger, so an empty one would fail to compile the moment someone pressed
 * Publish, and the first thing a new flow did would be to refuse itself.
 */
export const EMPTY_FLOW: FlowGraph = {
  nodes: [
    {
      id: 'trigger',
      kind: 'trigger',
      position: { x: 80, y: 160 },
      data: { label: 'Webhook received' },
    },
  ],
  edges: [],
}

/**
 * A flow that publishes and runs, straight out of the box.
 *
 * Every step kind that has an executor, in the order they make sense: the
 * webhook arrives, an API is called, the response and the payload are combined,
 * and the result is emailed. The URL is a real public endpoint so that pressing
 * Publish and sending a webhook actually does something.
 */
export const SAMPLE_FLOW: FlowGraph = {
  nodes: [
    {
      id: 'trigger',
      kind: 'trigger',
      position: { x: 0, y: 160 },
      data: { label: 'Webhook received' },
    },
    {
      id: 'lookup',
      kind: 'http',
      position: { x: 240, y: 160 },
      data: {
        label: 'Look up the repository',
        url: 'https://api.github.com/repos/nodejs/node',
        method: 'GET',
      },
    },
    {
      id: 'shape',
      kind: 'transform',
      position: { x: 490, y: 160 },
      data: {
        label: 'Build the summary',
        template: [
          '{',
          '  "repo": "{{ steps.lookup.output.body.full_name }}",',
          '  "stars": "{{ steps.lookup.output.body.stargazers_count }}",',
          '  "amount": "{{ trigger.body.data.object.amount_paid }}"',
          '}',
        ].join('\n'),
      },
    },
    {
      id: 'notify',
      kind: 'email',
      position: { x: 740, y: 160 },
      data: {
        label: 'Send the summary',
        // .test is reserved by RFC 2606 and can never be a real domain, so the
        // example cannot reach a person by accident.
        to: 'finance@example.test',
        subject: 'Invoice paid — {{ steps.shape.output.repo }}',
        body: [
          'An invoice was paid.',
          '',
          'Repository: {{ steps.shape.output.repo }}',
          'Stars:      {{ steps.shape.output.stars }}',
          'Amount:     {{ steps.shape.output.amount }}',
        ].join('\n'),
      },
    },
  ],
  edges: [
    { id: 'trigger->lookup', source: 'trigger', target: 'lookup' },
    { id: 'lookup->shape', source: 'lookup', target: 'shape' },
    { id: 'shape->notify', source: 'shape', target: 'notify' },
  ],
}

/**
 * The old sample: branched, and containing a real non-ancestor reference.
 *
 * Kept because the validation tests are about exactly these two problems, and
 * inventing a fresh broken graph in each test would be a worse way to describe
 * them than pointing at one everybody can see.
 */
export const BRANCHED_SAMPLE: FlowGraph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 0, y: 160 }, data: { label: 'Webhook received' } },
    { id: 'fetch', kind: 'http', position: { x: 220, y: 160 }, data: { label: 'Fetch customer', url: 'https://api.example.com/customers/1', method: 'GET' } },
    { id: 'check', kind: 'branch', position: { x: 460, y: 160 }, data: { label: 'Is premium?', condition: '{{ steps.fetch.output.tier }} = "premium"' } },
    { id: 'thanks', kind: 'email', position: { x: 700, y: 60 }, data: { label: 'Thank-you email', to: '{{ steps.fetch.output.email }}', subject: 'Thanks!', body: `Hi {{ steps.fetch.output.name }},\n\nThanks for upgrading — your premium features are live.` } },
    { id: 'notify', kind: 'email', position: { x: 700, y: 280 }, data: { label: 'Notify sales', to: '{{ steps.thanks.output.messageId }}', subject: 'New signup', body: 'A new signup came through: {{ steps.fetch.output.email }}' } },
  ],
  edges: [
    { id: 'trigger->fetch', source: 'trigger', target: 'fetch' },
    { id: 'fetch->check', source: 'fetch', target: 'check' },
    { id: 'check->thanks:yes', source: 'check', target: 'thanks', sourceHandle: 'yes' },
    { id: 'check->notify:no', source: 'check', target: 'notify', sourceHandle: 'no' },
  ],
}

/**
 * What each step produced.
 *
 * Sample data, used when no backend is connected and as the floor underneath a
 * real run: the mapping panel merges the last run over this, so a flow that has
 * never run still shows fields rather than an empty tree. The shapes are the
 * ones the real providers return, because a preview against invented shapes
 * teaches the wrong field names.
 */
export const SAMPLE_OUTPUTS: Record<string, { output: unknown }> = {
  trigger: {
    output: {
      event: "invoice.paid",
      receivedAt: "2026-03-01T09:14:02Z",
      body: { data: { object: { amount_paid: 4200, currency: "chf" } } },
    },
  },
  lookup: {
    output: {
      status: 200,
      body: {
        full_name: "nodejs/node",
        stargazers_count: 119635,
        open_issues_count: 1743,
        language: "JavaScript",
        owner: { login: "nodejs", type: "Organization" },
      },
    },
  },
  shape: { output: { repo: "nodejs/node", stars: 119635, amount: 4200 } },
}

/**
 * A past execution, for the run viewer.
 *
 * Carries its own copy of the graph, because a run belongs to the version it
 * ran on — rendering it against the current design would mean debugging
 * yesterday's failure on today's diagram.
 *
 * The email step is left `not_reached`, which is the case the viewer exists to
 * make visible: nothing failed, and the message simply never went out.
 */
export const SAMPLE_RUN: RunRecord = {
  id: "run_2f81",
  startedAt: "2026-03-01T09:14:02Z",
  finishedAt: "2026-03-01T09:14:05Z",
  status: "failed",
  graph: SAMPLE_FLOW,
  steps: [
    {
      nodeId: "trigger",
      outcome: "succeeded",
      durationMs: 4,
      output: SAMPLE_OUTPUTS.trigger!.output,
    },
    {
      nodeId: "lookup",
      outcome: "succeeded",
      durationMs: 318,
      attempts: 2,
      input: { url: "https://api.github.com/repos/nodejs/node", method: "GET" },
      output: SAMPLE_OUTPUTS.lookup!.output,
    },
    {
      nodeId: "shape",
      outcome: "failed",
      durationMs: 6,
      error: "unresolved reference: steps.lookup.output.body.owner.email",
    },
    { nodeId: "notify", outcome: "not_reached" },
  ],
}
