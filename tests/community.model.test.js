// Pure rules of the community proposal model (community/model.js): the
// status lifecycle, who may edit, vote and move a proposal, and validation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../community/model');

const author = { id: '1', username: 'alice', reviewer: false };
const other = { id: '2', username: 'bob', reviewer: false };
const reviewer = { id: '3', username: 'rita', reviewer: true };
const prop = (status, votes = { up: 0, down: 0 }) => ({ authorId: '1', status, votes });

test('every category and status from the spec exists', () => {
  assert.deepEqual(
    m.CATEGORIES.map((c) => c.id),
    [
      'add_missing_place',
      'correct_place',
      'update_hours',
      'correct_location',
      'report_wrong_information',
      'add_landmark',
      'suggest_map_improvement',
    ],
  );
  assert.deepEqual(
    m.STATUSES.map((s) => s.label),
    ['Draft', 'Open', 'Under Review', 'Accepted', 'Rejected', 'Implemented'],
  );
});

test('transitions: only listed moves, by the right role', () => {
  assert.doesNotThrow(() => m.assertTransition(author, prop('draft'), 'open'));
  assert.throws(() => m.assertTransition(other, prop('draft'), 'open'), { code: 'forbidden' });
  assert.throws(() => m.assertTransition(reviewer, prop('draft'), 'accepted'), { code: 'invalid_transition' });
  assert.throws(() => m.assertTransition(author, prop('open'), 'under_review'), { code: 'forbidden' });
  assert.doesNotThrow(() => m.assertTransition(reviewer, prop('open'), 'under_review'));
  assert.doesNotThrow(() => m.assertTransition(reviewer, prop('under_review'), 'accepted'));
  assert.doesNotThrow(() => m.assertTransition(reviewer, prop('accepted'), 'implemented'));
  for (const terminal of ['rejected', 'implemented']) {
    for (const to of ['draft', 'open', 'under_review', 'accepted', 'rejected', 'implemented']) {
      assert.throws(() => m.assertTransition(reviewer, prop(terminal), to), { code: 'invalid_transition' });
    }
  }
  assert.throws(() => m.assertTransition(reviewer, prop('open'), 'bogus'), { code: 'invalid_status' });
  assert.deepEqual(m.allowedTransitions(author, prop('draft')), ['open']);
  assert.deepEqual(m.allowedTransitions(other, prop('open')), []);
  assert.deepEqual(m.allowedTransitions(reviewer, prop('under_review')), ['accepted', 'rejected', 'open']);
});

test('edit: drafts always, open only before the first vote, never after', () => {
  assert.equal(m.canEdit(author, prop('draft')), true);
  assert.equal(m.canEdit(author, prop('open')), true);
  assert.equal(m.canEdit(author, prop('open', { up: 0, down: 1 })), false);
  assert.equal(m.canEdit(other, prop('draft')), false);
  assert.equal(m.canEdit(reviewer, prop('open')), false);
  for (const s of ['under_review', 'accepted', 'rejected', 'implemented']) {
    assert.equal(m.canEdit(author, prop(s)), false, s);
  }
});

test('vote: others only, while open or under review', () => {
  assert.equal(m.canVote(author, prop('open')), false);
  assert.equal(m.canVote(other, prop('open')), true);
  assert.equal(m.canVote(other, prop('under_review')), true);
  for (const s of ['draft', 'accepted', 'rejected', 'implemented']) {
    assert.equal(m.canVote(other, prop(s)), false, s);
  }
  assert.equal(m.parseVoteValue('1'), 1);
  assert.equal(m.parseVoteValue(-1), -1);
  assert.throws(() => m.parseVoteValue(0), { code: 'invalid_vote' });
});

test('drafts are visible to their author only', () => {
  assert.equal(m.canView(author, prop('draft')), true);
  assert.equal(m.canView(other, prop('draft')), false);
  assert.equal(m.canView(other, prop('open')), true);
  assert.equal(m.canView(other, { ...prop('open'), hidden: true }), false);
});

test('validateDraft cleans input and requires a location where the category needs one', () => {
  const ok = m.validateDraft({
    title: '  Fix   the  hours ',
    description: 'Opens at nine on Saturdays.',
    category: 'update_hours',
    location: { name: ' Library ', lat: '38.7', lng: -9.1 },
  });
  assert.equal(ok.title, 'Fix the hours');
  assert.deepEqual(ok.location, { name: 'Library', lat: 38.7, lng: -9.1 });
  assert.deepEqual(ok.attachments, []);

  const noLoc = m.validateDraft({
    title: 'Better cycle paths',
    description: 'Show separated cycle paths more clearly.',
    category: 'suggest_map_improvement',
  });
  assert.equal(noLoc.location, null);

  assert.throws(
    () => m.validateDraft({ title: 'Fix the hours', description: 'Opens at nine.', category: 'update_hours' }),
    (err) => err.code === 'invalid_proposal' && Boolean(err.fields.location),
  );
  assert.throws(
    () => m.validateDraft({ title: 'Ok title', description: 'Long enough text.', category: 'update_hours', location: { name: 'X', lat: 91, lng: 0 } }),
    (err) => Boolean(err.fields.location),
  );
});

test('attachments must be platform-stored image URLs, at most four, no repeats', () => {
  const base = { title: 'Ok title', description: 'Long enough text.', category: 'suggest_map_improvement' };
  const url = (c) => `https://p.test/app-files/${c.repeat(32)}`;
  const opts = { platformOrigin: 'https://p.test' };
  const ok = m.validateDraft({ ...base, attachments: [{ url: url('a'), contentType: 'image/png' }] }, opts);
  assert.equal(ok.attachments[0].id, 'a'.repeat(32));
  const bad = (attachments) =>
    assert.throws(() => m.validateDraft({ ...base, attachments }, opts), (e) => Boolean(e.fields.attachments));
  bad([{ url: 'https://other.test/app-files/' + 'a'.repeat(32) }]);
  bad([{ url: 'https://p.test/uploads/x.png' }]);
  bad([{ url: url('a'), contentType: 'application/pdf' }]);
  bad([{ url: url('a') }, { url: url('a') }]);
  bad(['a', 'b', 'c', 'd', 'e'].map((c) => ({ url: url(c) })));
});

test('feed query parsing', () => {
  assert.deepEqual(m.parseFeedQuery({}), { view: 'recent', limit: 20, offset: 0, near: null, radiusKm: 25 });
  assert.equal(m.parseFeedQuery({ view: 'nope' }).view, 'recent');
  assert.equal(m.parseFeedQuery({ limit: '500' }).limit, 50);
  assert.deepEqual(m.parseFeedQuery({ view: 'nearby', near: '1.5,2.5', radius: '999' }).near, { lat: 1.5, lng: 2.5 });
  assert.equal(m.parseFeedQuery({ view: 'nearby', near: '1.5,2.5', radius: '999' }).radiusKm, 200);
  assert.throws(() => m.parseFeedQuery({ view: 'nearby' }), { code: 'invalid_query' });
  assert.throws(() => m.parseFeedQuery({ view: 'nearby', near: '100,0' }), { code: 'invalid_query' });
});

test('reviewers are parsed case-insensitively', () => {
  assert.deepEqual([...m.parseReviewers(' Rita, bob ,,')], ['rita', 'bob']);
  assert.equal(m.parseReviewers('').size, 0);
});
