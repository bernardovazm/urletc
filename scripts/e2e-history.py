"""E2E: replayable history between two real browser contexts.

Separate from e2e-console.py because it needs a SECOND browser context and real
rendezvous over the relays, which costs tens of seconds; the main suite stays a
single fast page. It drives the user's actual scenario end to end:

  A opens a code room and says three things, then reloads, so what is replayed can
  only have come back out of the encrypted store and not out of the in-memory outbox
  (which would otherwise deliver the same text live and make a dead replay look alive:
  that confound is exactly why this was reported as working when it was not).
  B then joins the same code from a #/join link, like someone handed the link.

Asserted, in order: the store survives the reload; B gets NOTHING by default (a
forwarded code must not replay a room's past on its own); A is ASKED, by name and
count; the grant delivers the real message text to B; and the grant was per-person,
so a later joiner C still gets nothing.
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://localhost:5199')
# Unique per run for the same reason the console suite randomises its code: a fixed
# literal lets a concurrent run (or the developer's own tab) join the room under test.
CODE = 'hist' + os.urandom(3).hex()
MSGS = ['alpha replay one', 'bravo replay two', 'charlie replay three']
HANDSHAKE_TIMEOUT = 120  # seconds; third-party relays are slow before they are wrong
passed, failed = [], []


def check(name, cond, extra=''):
    (passed if cond else failed).append(f'{name}{": " + extra if extra and not cond else ""}')
    print(('PASS' if cond else 'FAIL'), name, extra if not cond else '', flush=True)


def wait_for(fn, timeout, step=1.0):
    """Poll until fn() is truthy. Returns the value (or the last falsy one)."""
    deadline = time.time() + timeout
    val = None
    while time.time() < deadline:
        val = fn()
        if val:
            return val
        time.sleep(step)
    return val


def join(browser, label):
    ctx = browser.new_context()
    pg = ctx.new_page()
    pg.goto(f'{BASE}/#/join/{CODE}')
    pg.wait_for_selector('.composer', timeout=30000)
    print(f'  [{label}] mounted on {CODE}', flush=True)
    return pg


def feed(pg):
    return pg.locator('.feed').inner_text()


def handshaked(pg):
    return 'Secure channel established' in feed(pg)


def open_connect(pg):
    pg.locator('.topbar button', has_text='Connect').click()
    pg.wait_for_selector('.modal .group-label:has-text("Earlier messages")', timeout=10000)
    return pg.locator('.modal')


def close_connect(pg):
    pg.keyboard.press('Escape')
    time.sleep(0.4)
    if pg.locator('.modal').count():
        pg.locator('.modal button', has_text='Close').first.click()
        time.sleep(0.4)


def replay_card(pg):
    return pg.locator('.card', has_text='Earlier messages')


def read_card(pg):
    """Expand the replay card and read its BODY.

    The card is a collapsed <details>, so its summary renders "Earlier messages (3)"
    whether or not a single message made it inside. Reading the closed summary is how a
    test passes on an empty card, so it is expanded here and the bodies are read: the
    assertion is on the text a person would actually see.
    """
    card = replay_card(pg)
    if not card.count():
        return ''
    card.first.locator('summary').click()
    pg.wait_for_timeout(300)
    return '\n'.join(card.first.locator('.bubble').all_inner_texts())


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    # try/finally, not a bare close at the end: an assertion that raises would otherwise
    # leave a headless browser alive and still joined to the room. Those survivors are
    # discoverable peers, and they make later runs of BOTH suites fail in ways that look
    # like product bugs (a message that should queue gets delivered to a ghost instead).
    try:

        # --- A: hold a room, say things, then reload so only the store can answer ---
        A = join(browser, 'A')
        time.sleep(3)
        for m in MSGS:
            A.locator('.composer textarea').fill(m)
            A.locator('.composer textarea').press('Enter')
            time.sleep(0.5)
        time.sleep(2)
        A.reload()
        A.wait_for_selector('.composer', timeout=30000)
        time.sleep(4)

        check('A rejoins its own code after a reload', f'/join/{CODE}' in A.evaluate('location.hash'),
              A.evaluate('location.hash'))

        modal = open_connect(A)
        boxes = modal.evaluate("el => [...el.querySelectorAll('label.row.small input[type=checkbox]')].map(c => c.checked)")
        labels = [t.strip() for t in modal.locator('label.row.small').all_inner_texts()]
        by_label = dict(zip(labels, boxes))
        code_label = next((l for l in labels if 'join by code' in l), '')
        ask_label = next((l for l in labels if 'Ask for earlier messages' in l), '')
        check('sharing into code rooms is OFF by default', by_label.get(code_label) is False, str(by_label))
        check('asking for earlier messages is ON by default', by_label.get(ask_label) is True, str(by_label))

        note = ' '.join(modal.locator('.muted.small').all_inner_texts())
        check('A kept the messages on this device across a reload', 'kept on this device' in note, note[:160])
        modal.locator('button', has_text='Show what is stored').click()
        time.sleep(1)
        stored = read_card(A)
        check('the store reads back the real message text', all(m in stored for m in MSGS), repr(stored[:200]))
        close_connect(A)

        # --- B: joins the link afterwards ---
        B = join(browser, 'B')
        check('B reaches A over the relays', bool(wait_for(lambda: handshaked(B), HANDSHAKE_TIMEOUT)),
              f'no handshake in {HANDSHAKE_TIMEOUT}s (relays down?)')

        # Default is off, and it must STAY off without a human in the loop: a six character
        # code travels to whoever it is forwarded to, so silence is the correct answer here.
        time.sleep(8)
        check('B is replayed nothing while sharing is off', replay_card(B).count() == 0,
              feed(B)[:200])

        # ...but A is asked, in the feed, at the moment it matters. This is the whole fix:
        # the setting used to be reachable only by opening a modal nobody had a reason to open.
        prompt = wait_for(lambda: A.locator('.sys', has_text='asked for the').count() and A.locator('.sys', has_text='asked for the').first, 30)
        check('A is asked to share, in the feed, when someone joins', bool(prompt),
              feed(A)[-300:])
        if prompt:
            txt = prompt.inner_text()
            check('the prompt names the peer and counts the messages', 'joined and asked for the' in txt and str(len(MSGS)) in txt, txt[:160])
            check('the prompt offers per-person, always, and refuse', 
                  all(prompt.locator('button', has_text=t).count() == 1 for t in ('Send them', 'Always in code rooms', 'No')),
                  txt[:160])
            prompt.locator('button', has_text='Send them').click()

        arrived = wait_for(lambda: replay_card(B).count() > 0, 40)
        check('B receives the replay after the grant', bool(arrived), feed(B)[:300])
        check('the replay is labelled as replayed, not as live chat',
              'replayed from' in (replay_card(B).first.inner_text() if arrived else ''), feed(B)[:200])
        got = read_card(B) if arrived else ''
        check('the replay carries every earlier message, verbatim', all(m in got for m in MSGS) if got else False,
              repr(got[:250]))
        check('the replay does not render as live chat bubbles in the feed',
              not any(m in feed(B).split('Earlier messages')[0] for m in MSGS), feed(B)[:200])
        check('A reports what it sent', 'earlier messages to' in feed(A), feed(A)[-200:])

        # The grant was for one person. It must not have flipped the room's default, or the
        # privacy property that made it default-off is gone the first time anyone says yes.
        modal = open_connect(A)
        boxes = modal.evaluate("el => [...el.querySelectorAll('label.row.small input[type=checkbox]')].map(c => c.checked)")
        labels = [t.strip() for t in modal.locator('label.row.small').all_inner_texts()]
        check('a per-person grant does not flip the room default', dict(zip(labels, boxes)).get(code_label) is False,
              str(dict(zip(labels, boxes))))
        close_connect(A)

        C = join(browser, 'C')
        if not wait_for(lambda: handshaked(C), HANDSHAKE_TIMEOUT):
            check('a later joiner is still replayed nothing', False, 'C never handshaked')
        else:
            time.sleep(10)
            check('a later joiner is still replayed nothing', replay_card(C).count() == 0, feed(C)[:200])

            # The other half of the fix: saying "always" must answer the person ALREADY
            # waiting, not just the next one. A peer asks exactly once, at handshake, so
            # without a deferred answer this switch could only ever help a future joiner
            # and the person in front of you would keep seeing nothing.
            p2 = wait_for(lambda: A.locator('.sys', has_text='asked for the').count() and A.locator('.sys', has_text='asked for the').first, 30)
            check('A is asked again for the new joiner', bool(p2), feed(A)[-250:])
            if p2:
                p2.locator('button', has_text='Always in code rooms').click()
                arrived = wait_for(lambda: replay_card(C).count() > 0, 40)
                check('turning sharing on answers the peer already waiting', bool(arrived), feed(C)[-250:])
                got_c = read_card(C) if arrived else ''
                check('that late answer carries the real messages too', all(m in got_c for m in MSGS) if got_c else False,
                      repr(got_c[:250]))
                check('the answered question is retired from the feed',
                      A.locator('.sys', has_text='asked for the').count() == 0,
                      feed(A)[-200:])
                modal = open_connect(A)
                boxes = modal.evaluate("el => [...el.querySelectorAll('label.row.small input[type=checkbox]')].map(c => c.checked)")
                labels = [t.strip() for t in modal.locator('label.row.small').all_inner_texts()]
                check('"always" is the same switch the modal shows', dict(zip(labels, boxes)).get(code_label) is True,
                      str(dict(zip(labels, boxes))))
                close_connect(A)

    finally:
        browser.close()

print(f'\n=== history: {len(passed)} passed, {len(failed)} failed ===')
for f_ in failed:
    print('FAILED:', f_)
sys.exit(1 if failed else 0)
