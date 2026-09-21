/**
 * Demo rehearsal: runs the five demo fixtures through the real pipeline and
 * reports, per case, what was expected and what actually happened.
 *
 * Every classification is a live provider call. Every document is real bytes
 * read from disk through the same reader the product uses. Nothing here is
 * scripted: if the pipeline disagrees with the documented expectation, this
 * prints a mismatch and exits non-zero.
 *
 *   set -a && . ./.env && set +a
 *   npx tsx tools/demo/src/rehearse.ts
 */
import { resolve } from 'node:path';
import { questionVersion } from '@cargolens/shared/questions';
import { createJevProvider } from '../../../apps/api/src/ai/jev.js';
import { loadDataset } from '../../../apps/api/src/dataset.js';
import { ClassificationService } from '../../../apps/api/src/pipeline.js';
import { Store } from '../../../apps/api/src/store.js';
import { composeDraft } from '../../../apps/api/src/drafts.js';
import { DEMO_EXPECTATIONS } from './expectations.js';

const root = resolve(process.env.DEMO_FIXTURE_ROOT ?? 'tools/demo/fixtures');
const model = process.env.TYPESAFE_MODEL ?? 'jev-1.13.0';
const variant = process.env.JEV_PROMPT_VARIANT === 'concise' ? 'concise' : 'boundaries';

function arraysEqual(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required: the rehearsal makes real classification calls.');

  const store = new Store(':memory:');
  const provider = createJevProvider({ apiKey, model, variant, mode: 'full' });
  const service = new ClassificationService({ store, classifier: provider.classify,
    configurationKey: `${model}:${questionVersion(variant, 'full')}:provider=typesafe`,
    concurrency: Number(process.env.JEV_CONCURRENCY ?? 8) });

  const emails = await loadDataset(root);
  console.log(`CargoLens demo rehearsal — ${emails.length} fixture cases`);
  console.log(`model ${model} · questions ${questionVersion(variant, 'full')} · documents read from ${root}\n`);

  const started = performance.now();
  await Promise.all(emails.map((email) => service.processCase(email, root)));
  const wallMs = performance.now() - started;

  let failures = 0;
  for (const expectation of DEMO_EXPECTATIONS) {
    const record = store.getCase(expectation.id);
    const decision = record?.decision;
    const problems: string[] = [];
    const check = (label: string, actual: unknown, wanted: unknown) => {
      if (wanted !== undefined && actual !== wanted) problems.push(`${label}: expected ${String(wanted)}, observed ${String(actual)}`);
    };
    check('category', decision?.category, expectation.expect.category);
    check('requestedAction', decision?.requestedAction, expectation.expect.requestedAction);
    check('workflowState', decision?.workflowState, expectation.expect.workflowState);
    check('nextAction', decision?.nextAction, expectation.expect.nextAction);
    if (expectation.expect.mismatches && !arraysEqual(decision?.knownMismatches ?? [], expectation.expect.mismatches)) {
      problems.push(`mismatches: expected [${expectation.expect.mismatches.join(', ')}], observed [${(decision?.knownMismatches ?? []).join(', ')}]`);
    }
    for (const blocker of expectation.expect.blockers ?? []) {
      if (!decision?.blockers.includes(blocker)) problems.push(`blocker ${blocker} was not raised (observed [${(decision?.blockers ?? []).join(', ')}])`);
    }

    console.log(`${problems.length ? 'MISMATCH' : 'AGREES  '}  ${expectation.id}  [${expectation.evidence}]`);
    console.log(`          ${expectation.what}`);
    console.log(`          observed: category=${decision?.category ?? 'none'} action=${decision?.requestedAction ?? 'none'} ` +
      `state=${decision?.workflowState ?? 'none'} next=${decision?.nextAction ?? 'none'} ` +
      `mismatches=[${(decision?.knownMismatches ?? []).join(', ')}] blockers=[${(decision?.blockers ?? []).join(', ')}]`);
    if (record && decision && decision.nextAction !== 'NONE' && decision.nextAction !== 'FETCH_THREAD') {
      // Show the reply the case would actually produce, so responsibility is visible.
      try {
        const draft = composeDraft(record, process.env.GMAIL_DOCUMENTATION_CONTACT);
        console.log(`          would reply to ${draft.to} as ${draft.action}`);
      } catch (error) {
        console.log(`          no reply composed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    for (const problem of problems) console.log(`          ! ${problem}`);
    console.log(`          why: ${expectation.why}\n`);
    if (problems.length) failures++;
  }

  console.log(`Measured wall time for ${emails.length} fixture cases: ${(wallMs / 1000).toFixed(2)} s ` +
    `(classification is live; document bytes are fixtures read from disk).`);
  console.log(`Cases agreeing with documented behaviour: ${DEMO_EXPECTATIONS.length - failures}/${DEMO_EXPECTATIONS.length}`);
  store.close();
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Rehearsal failed'); process.exitCode = 1; });
