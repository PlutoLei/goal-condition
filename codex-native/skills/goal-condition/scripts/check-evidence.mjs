#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const levels = new Set(['mock', 'local', 'external', 'independent']);
const statuses = new Set(['passed', 'failed', 'not-run', 'not-applicable']);
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0;

// This checks a supplied report. It neither executes source strings nor certifies their truth.
export function checkEvidence(report) {
  const issues = [];
  if (!report || !Array.isArray(report.criteria) || report.criteria.length === 0
      || !Array.isArray(report.evidence) || !Array.isArray(report.remaining_work)
      || !report.remaining_work.every(nonempty)) {
    return { requirements_met: false, issues: [{ code: 'REPORT_INVALID' }], exclusions: [] };
  }
  const criteria = new Map();
  for (const c of report.criteria) {
    if (!c || !nonempty(c.id) || criteria.has(c.id) || typeof c.required !== 'boolean'
        || !levels.has(c.required_level) || !statuses.has(c.status)) {
      issues.push({ code: 'CRITERION_INVALID' });
    } else criteria.set(c.id, c);
  }
  const evidence = new Map();
  const ids = new Set();
  for (const e of report.evidence) {
    if (!e || !nonempty(e.id) || ids.has(e.id) || !criteria.has(e.criterion_id)
        || !levels.has(e.level) || typeof e.passed !== 'boolean'
        || typeof e.current !== 'boolean' || !nonempty(e.source)) {
      issues.push({ code: 'EVIDENCE_INVALID' });
      continue;
    }
    ids.add(e.id);
    const list = evidence.get(e.criterion_id) ?? [];
    list.push(e);
    evidence.set(e.criterion_id, list);
  }
  if (![...criteria.values()].some((c) => c.required)) issues.push({ code: 'NO_REQUIRED_CRITERIA' });
  const exclusions = [];
  for (const c of criteria.values()) {
    if (!c.required) {
      exclusions.push({ criterion: c.id, status: c.status });
      if (c.status === 'not-applicable' && !nonempty(c.reason)) {
        issues.push({ code: 'EXCLUSION_REASON_REQUIRED', criterion: c.id });
      }
      continue;
    }
    if (c.status !== 'passed') issues.push({ code: 'REQUIRED_NOT_PASSED', criterion: c.id });
    const items = evidence.get(c.id) ?? [];
    if (items.length === 0) issues.push({ code: 'EVIDENCE_MISSING', criterion: c.id });
    for (const e of items) {
      if (e.level !== c.required_level) issues.push({ code: 'EVIDENCE_SCOPE_MISMATCH', criterion: c.id });
      if (!e.current) issues.push({ code: 'EVIDENCE_STALE', criterion: c.id });
      if (!e.passed) issues.push({ code: 'EVIDENCE_FAILED', criterion: c.id });
    }
  }
  if (report.remaining_work.length > 0) issues.push({ code: 'REMAINING_WORK' });
  return { requirements_met: issues.length === 0, issues, exclusions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    if (process.argv.length !== 3) throw new Error('one report required');
    result = checkEvidence(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  } catch { result = { requirements_met: false, issues: [{ code: 'REPORT_UNREADABLE' }], exclusions: [] }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.requirements_met ? 0 : 1;
}
