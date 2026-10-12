// Reputation model — the closed catalog, its points and the level labels.
// Pure rules, no database. Phase 12I slice 1.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../community/reputation-model');

test('the catalog is exactly the six spec events, with their points', () => {
  assert.deepEqual(
    [...model.EVENT_TYPES].sort(),
    [
      'abuse_penalty',
      'abuse_penalty_reversed',
      'proposal_accepted',
      'proposal_implemented',
      'proposal_published',
      'report_verified',
    ].sort(),
  );
  assert.equal(model.pointsFor('proposal_published'), 2);
  assert.equal(model.pointsFor('proposal_accepted'), 5);
  assert.equal(model.pointsFor('proposal_implemented'), 5);
  assert.equal(model.pointsFor('report_verified'), 3);
  assert.equal(model.pointsFor('abuse_penalty'), -10);
  assert.equal(model.pointsFor('abuse_penalty_reversed'), 10);
});

test('every catalog event names the target it is keyed to', () => {
  for (const [eventType, def] of Object.entries(model.EVENTS)) {
    assert.ok(
      def.targetType === 'proposal' || def.targetType === 'report' || def.targetType === 'case',
      eventType,
    );
    assert.equal(typeof def.points, 'number', eventType);
  }
});

test('unknown events have no points: votes and reactions earn nothing', () => {
  assert.equal(model.pointsFor('vote_cast'), null);
  assert.equal(model.pointsFor('report_flagged'), null);
  assert.equal(model.pointsFor('made_up'), null);
  assert.equal(model.isKnownEvent('vote_cast'), false);
  assert.equal(model.isKnownEvent('proposal_accepted'), true);
});

test('levels are labels with the documented thresholds, negative totals included', () => {
  assert.equal(model.levelFor(0), 'new');
  assert.equal(model.levelFor(9), 'new');
  assert.equal(model.levelFor(10), 'contributor');
  assert.equal(model.levelFor(49), 'contributor');
  assert.equal(model.levelFor(50), 'trusted');
  assert.equal(model.levelFor(1000), 'trusted');
  // A negative total is shown as-is; it is still the 'new' level.
  assert.equal(model.levelFor(-10), 'new');
});

test('a publish-at-create earns proposal_published for its author', () => {
  const a = model.awardForCommunityEvent('proposal.created', {
    viewer: { id: 202, username: 'bob' },
    proposal: { id: '900001', status: 'open', author: { id: 101, username: 'alice' } },
  });
  assert.deepEqual(a, {
    eventType: 'proposal_published',
    userId: 101,
    targetType: 'proposal',
    targetId: '900001',
  });
});

test('a plain draft create earns nothing; publishing the draft later does', () => {
  const created = model.awardForCommunityEvent('proposal.created', {
    proposal: { id: '900001', status: 'draft', author: { id: 101, username: 'alice' } },
  });
  assert.equal(created, null);

  const published = model.awardForCommunityEvent('proposal.status_changed', {
    proposal: { id: '900001', status: 'open', author: { id: 101, username: 'alice' } },
    from: 'draft',
    to: 'open',
  });
  assert.equal(published.eventType, 'proposal_published');
  assert.equal(published.userId, 101);
  assert.equal(published.targetId, '900001');
});

test('a re-open from under review is not a publish', () => {
  const a = model.awardForCommunityEvent('proposal.status_changed', {
    proposal: { id: '900001', status: 'open', author: { id: 101, username: 'alice' } },
    from: 'under_review',
    to: 'open',
  });
  assert.equal(a, null);
});

test('reviewer moves to accepted and implemented earn their events', () => {
  const accepted = model.awardForCommunityEvent('proposal.status_changed', {
    proposal: { id: '900002', status: 'accepted', author: { id: 101, username: 'alice' } },
    from: 'under_review',
    to: 'accepted',
  });
  assert.equal(accepted.eventType, 'proposal_accepted');
  const implemented = model.awardForCommunityEvent('proposal.status_changed', {
    proposal: { id: '900002', status: 'implemented', author: { id: 101, username: 'alice' } },
    from: 'accepted',
    to: 'implemented',
  });
  assert.equal(implemented.eventType, 'proposal_implemented');
  assert.equal(implemented.userId, 101);
});

test('a verified report earns report_verified for the reporter; rejected earns nothing', () => {
  const verified = model.awardForCommunityEvent('report.status_changed', {
    viewer: { id: 204, username: 'Rita' },
    report: { id: '920002', status: 'verified', reporter: { id: 103, username: 'carol' } },
    from: 'pending',
    to: 'verified',
  });
  assert.deepEqual(verified, {
    eventType: 'report_verified',
    userId: 103,
    targetType: 'report',
    targetId: '920002',
  });

  const rejected = model.awardForCommunityEvent('report.status_changed', {
    report: { id: '920003', status: 'rejected', reporter: { id: 103, username: 'carol' } },
    from: 'verified',
    to: 'rejected',
  });
  assert.equal(rejected, null);
});

test('unrelated events and malformed payloads earn nothing', () => {
  assert.equal(model.awardForCommunityEvent('vote.cast', { value: 1 }), null);
  assert.equal(model.awardForCommunityEvent('proposal.updated', {
    proposal: { id: '1', status: 'open', author: { id: 101 } },
  }), null);
  assert.equal(model.awardForCommunityEvent('proposal.created', null), null);
  assert.equal(model.awardForCommunityEvent('proposal.created', {}), null);
  assert.equal(model.awardForCommunityEvent('report.status_changed', { to: 'verified' }), null);
});
