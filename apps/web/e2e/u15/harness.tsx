/**
 * U15.1 real-browser harness: mounts the production design-system components
 * (src/components/ui) outside the Next.js app, styled by the real globals.css
 * compiled with Tailwind. Bundled by u15-components.spec.ts with esbuild and served
 * through Playwright request routing — no server, API, database or login.
 *
 * The rows below are layout fixtures for the table component, not metrics.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  AccessibleDialog,
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  PasswordInput,
  SearchInput,
  Select,
  StatCard,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemePreferenceControl,
  breadcrumbsFromPath,
  type DataTableColumn,
  type DataTableQueryState,
} from '../../src/components/ui';
import { startThemeSync } from '../../src/lib/theme-store';

type Row = { id: string; name: string; channel: string; status: 'success' | 'warning' | 'error' };
const ROWS: Row[] = [
  { id: 'r3', name: 'Fixture row C', channel: 'SMS', status: 'success' },
  { id: 'r1', name: 'Fixture row A', channel: 'RCS', status: 'warning' },
  { id: 'r2', name: 'Fixture row B', channel: 'WhatsApp', status: 'error' },
];
const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortField: 'name' },
  { id: 'channel', header: 'Channel', cell: (r) => r.channel, sortField: 'channel' },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => (
      <StatusBadge
        variant={r.status}
        label={r.status === 'success' ? 'Delivered' : r.status === 'warning' ? 'Queued' : 'Failed'}
      />
    ),
  },
];
const CHANNELS = [
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email', disabled: true },
  {
    label: 'Rich messaging',
    items: [
      { value: 'rcs', label: 'RCS' },
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'viber', label: 'Viber' },
    ],
  },
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-section={id}
      aria-labelledby={`${id}-title`}
      className="rounded-xl border border-acc-border bg-acc-card p-5"
    >
      <h2 id={`${id}-title`} className="mb-4 text-sm font-semibold text-acc-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Harness() {
  const [channel, setChannel] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const [drawer, setDrawer] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [query, setQuery] = useState<DataTableQueryState>({ pageSize: 3, filters: {}, page: 1 });
  const [events, setEvents] = useState<string[]>([]);
  const log = (e: string) => setEvents((list) => [...list, e]);

  return (
    <main className="min-h-dvh bg-acc-bg p-6 text-acc-text-primary">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">U15.1 design system harness</h1>
        <ThemePreferenceControl />
      </header>
      <output id="events" className="sr-only">
        {events.join('|')}
      </output>
      <div className="grid gap-6">
        <Section id="buttons" title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button data-contrast="text">Primary</Button>
            <Button variant="secondary" data-contrast="text">
              Secondary
            </Button>
            <Button variant="outline" data-contrast="text" data-contrast-border>
              Outline
            </Button>
            <Button variant="ghost" data-contrast="text">
              Ghost
            </Button>
            <Button variant="destructive" data-contrast="text">
              Delete
            </Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Saving</Button>
            <IconButton label="Close panel" icon={<span>×</span>} />
          </div>
        </Section>

        <Section id="inputs" title="Inputs">
          <div className="grid max-w-xl gap-4">
            <Input
              label="Display name"
              placeholder="Acme Retail"
              helperText="Shown to your team"
              data-contrast-border
            />
            <Input
              id="email-field"
              label="Email"
              defaultValue="not-an-email"
              error="Enter a valid email address"
            />
            <Input label="Disabled field" disabled defaultValue="Locked" />
            <PasswordInput id="password-field" label="Password" defaultValue="hunter2-example" />
            <SearchInput label="Search messages" placeholder="Search by recipient" />
          </div>
        </Section>

        <Section id="select" title="Select">
          <div className="grid max-w-xs gap-4">
            <Select
              id="channel-select"
              label="Channel"
              options={CHANNELS}
              value={channel}
              onValueChange={setChannel}
              helperText="Grouped options; Email is disabled"
            />
            <Select
              label="Required channel"
              options={CHANNELS}
              value={null}
              onValueChange={() => {}}
              error="Choose a channel"
            />
          </div>
        </Section>

        <Section id="badges" title="Badges">
          <div className="flex flex-wrap gap-2">
            <StatusBadge variant="success" label="Delivered" data-contrast="text" />
            <StatusBadge variant="warning" label="Queued" data-contrast="text" />
            <StatusBadge variant="error" label="Failed" data-contrast="text" />
            <StatusBadge variant="accent" label="Scheduled" data-contrast="text" />
            <StatusBadge variant="neutral" label="Draft" data-contrast="text" />
            <Badge variant="neutral">Plain badge</Badge>
          </div>
        </Section>

        <Section id="cards" title="Cards and stat cards">
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              label="With a value (fixture)"
              value={1234}
              description="Value passed by the caller"
            />
            <StatCard label="Loading" value={undefined} isLoading />
            <StatCard label="No data" value={null} />
          </div>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Existing card (unchanged)</CardTitle>
              <CardDescription>Production pages keep their current card styling.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">Card content</p>
            </CardContent>
          </Card>
        </Section>

        <Section id="navigation" title="Breadcrumb and tabs">
          <Breadcrumb
            items={breadcrumbsFromPath(
              '/organizations/01a16d1b-a2da-72bd-8124-3c4b4471b9d5/members',
              { organizations: 'Organizations' },
            )}
          />
          <Tabs value={tab} onValueChange={setTab} className="mt-4">
            <TabsList label="Message views">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="failed">Failed</TabsTrigger>
              <TabsTrigger value="archived" disabled>
                Archived
              </TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            </TabsList>
            <TabsContent value="all">All messages panel</TabsContent>
            <TabsContent value="failed">Failed messages panel</TabsContent>
            <TabsContent value="archived">Archived panel</TabsContent>
            <TabsContent value="scheduled">Scheduled panel</TabsContent>
          </Tabs>
          <Tabs defaultValue="no-such-tab" className="mt-4">
            <TabsList label="Unmatched views">
              <TabsTrigger value="first" disabled>
                First (disabled)
              </TabsTrigger>
              <TabsTrigger value="second">Second</TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section id="table" title="Data table (server-driven)">
          <DataTable<Row>
            caption="Fixture messages"
            columns={[
              ...COLUMNS,
              {
                id: 'actions',
                header: 'Actions',
                align: 'right',
                cell: (r) => (
                  <Button size="sm" variant="ghost" onClick={() => log(`action:${r.id}`)}>
                    Revoke {r.name}
                  </Button>
                ),
              },
            ]}
            data={ROWS}
            getRowKey={(r) => r.id}
            isLoading={false}
            hasNextPage
            hasPreviousPage={false}
            nextCursor="cursor-2"
            previousCursor={null}
            queryState={query}
            onQueryChange={(change) => {
              log(`query:${JSON.stringify(change)}`);
              setQuery((q) => ({ ...q, ...change }));
            }}
            emptyState={<EmptyState title="No messages" />}
            onRowClick={(r) => log(`row:${r.id}`)}
            rowActionLabel={(r) => `Open ${r.name}`}
          />
        </Section>

        <Section id="empty" title="Empty state and overlays">
          <EmptyState
            title="No messages yet"
            description="Messages you send appear here."
            action={<Button onClick={() => setDialog(true)}>Send first message</Button>}
          />
          <div className="mt-2 flex justify-center gap-3">
            <Button variant="outline" id="open-drawer" onClick={() => setDrawer(true)}>
              Open inspector
            </Button>
          </div>
        </Section>
      </div>

      <div className="fixed right-6 bottom-4 w-56" data-section="bottom-select">
        <Select
          id="bottom-select"
          label="Bottom select"
          options={CHANNELS}
          value={null}
          onValueChange={() => {}}
        />
      </div>

      <Drawer isOpen={drawer} onClose={() => setDrawer(false)} titleId="drawer-title">
        <h2 id="drawer-title" className="text-base font-semibold">
          Inspector
        </h2>
        <Input label="Drawer field" />
        <Select
          label="Drawer filter"
          options={CHANNELS}
          value={drawerFilter}
          onValueChange={setDrawerFilter}
        />
        <Button className="mt-4" onClick={() => setDrawer(false)}>
          Close inspector
        </Button>
      </Drawer>
      <AccessibleDialog isOpen={dialog} onClose={() => setDialog(false)} titleId="dialog-title">
        <h2 id="dialog-title">Send a message</h2>
        <Button onClick={() => setDialog(false)}>Done</Button>
      </AccessibleDialog>
    </main>
  );
}

startThemeSync();
createRoot(document.getElementById('root')!).render(<Harness />);
