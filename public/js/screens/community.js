// Community — the five areas Homeroom Maps is built around, each shown as a
// "coming soon" card. Phase 0 ships the STRUCTURE only: the architecture for
// proposals, voting, reports, contributions and discussions is defined in
// ../services/community.js as documented interfaces with no backend, and no
// data table exists yet. This list is static on purpose.
import { el } from '../components/dom.js';
import { placeholderPanel } from '../components/placeholder-panel.js';

const AREAS = [
  {
    title: 'Proposals',
    description: 'Suggest a place, a fix or a feature for the community to consider.',
  },
  {
    title: 'Voting',
    description: 'Decide together which proposals the map should adopt.',
  },
  {
    title: 'Reports',
    description: 'Flag something wrong or out of date on the map.',
  },
  {
    title: 'Contributions',
    description: 'Add or improve places, details and local knowledge.',
  },
  {
    title: 'Discussions',
    description: 'Talk through changes with the people who know the area.',
  },
];

export async function render(ctx) {
  ctx.content.replaceChildren(
    el('h1', { class: 'text-xl font-semibold tracking-tight text-ink', text: 'Community' }),
    el('p', {
      class: 'text-sm text-muted leading-relaxed',
      text: 'Homeroom Maps is shaped by its community. These are the ways to take part. Every one is coming soon.',
    }),
    el(
      'div',
      { class: 'flex flex-col gap-3' },
      AREAS.map((area) =>
        placeholderPanel({ title: area.title, description: area.description }),
      ),
    ),
  );
}
