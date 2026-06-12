// Validation tests for parser.js against the real Zillow samples from the brief.
// Run with: npm test  (uses node:test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentText, parseAgentSegments, parseLocation, dedupeBrokerage } from '../src/parser.js';

const mead = parseLocation('Mead, CO');

const CASES = [
    {
        raw: 'TEAM5.0 (5,476)8z Real Estate8z Real Estate$18K - $11M team price range1,012 team sales last 12 months33 team sales in Mead',
        expect: {
            Name: '8z Real Estate',
            Rating: '5.0',
            'Review Count': '5476',
            'Average Sales Volume': '$18K - $11M',
            'Sales Count Last Year': '1012',
            'Local Sales Count': '33',
            'Top Agent on Zillow': 'No',
            'Team Name': '8z Real Estate',
        },
    },
    {
        raw: 'Dina Young5.0 (39)Resident Realty$220K - $1.6M price range14 sales last 12 months5 sales in Mead',
        expect: {
            Name: 'Dina Young',
            Brokerage: 'Resident Realty',
            Rating: '5.0',
            'Review Count': '39',
            'Average Sales Volume': '$220K - $1.6M',
            'Sales Count Last Year': '14',
            'Local Sales Count': '5',
            'Team Name': '',
        },
    },
    {
        raw: 'Tracy McClung5.0 (53)RE/MAX Nexus$348K - $874K price range6 sales last 12 months5 sales in Mead',
        expect: {
            Name: 'Tracy McClung',
            Brokerage: 'RE/MAX Nexus',
            Rating: '5.0',
            'Review Count': '53',
            'Average Sales Volume': '$348K - $874K',
            'Sales Count Last Year': '6',
            'Local Sales Count': '5',
        },
    },
    {
        raw: 'HEATHER BERRY5.0 (47)Your Berry Own Home Powered by: LoKation Real Estate$75K - $950K price range7 sales last 12 months3 sales in Mead',
        expect: {
            Name: 'HEATHER BERRY',
            Brokerage: 'Your Berry Own Home Powered by: LoKation Real Estate',
            Rating: '5.0',
            'Review Count': '47',
            'Average Sales Volume': '$75K - $950K',
            'Sales Count Last Year': '7',
            'Local Sales Count': '3',
        },
    },
    {
        raw: 'Lindsay Preston5.0 (20)Preston PropertiesNo recent price rangeNo sales last 12 monthsNo sales in Mead',
        expect: {
            Name: 'Lindsay Preston',
            Brokerage: 'Preston Properties',
            Rating: '5.0',
            'Review Count': '20',
            'Average Sales Volume': '',
            'Sales Count Last Year': '0',
            'Local Sales Count': '0',
        },
    },
];

for (const { raw, expect } of CASES) {
    test(`parses: ${raw.slice(0, 40)}...`, () => {
        const agent = parseAgentText(raw, 'https://www.zillow.com/profile/test/', mead);
        for (const [key, val] of Object.entries(expect)) {
            assert.equal(agent[key], val, `field "${key}"`);
        }
        // Location fields always populated from search input.
        assert.equal(agent['City'], 'Mead');
        assert.equal(agent['State'], 'CO');
    });
}

test('parseLocation handles ZIP codes', () => {
    const loc = parseLocation('80542');
    assert.equal(loc.slug, '80542');
    assert.equal(loc.zip, '80542');
    assert.equal(loc.city, '');
    assert.equal(loc.state, '');
});

test('parseLocation slugifies city/state', () => {
    assert.equal(parseLocation('Boulder, CO').slug, 'boulder-co');
    assert.equal(parseLocation('Mead, CO').slug, 'mead-co');
    const loc = parseLocation('Boulder, CO');
    assert.equal(loc.city, 'Boulder');
    assert.equal(loc.state, 'CO');
});

test('dedupeBrokerage collapses exact doubled text', () => {
    assert.equal(dedupeBrokerage('8z Real Estate8z Real Estate'), '8z Real Estate');
    assert.equal(dedupeBrokerage('Resident Realty'), 'Resident Realty');
});

// --- Segment-based parsing (real captured DOM structure from live Zillow) ---
const SEGMENT_CASES = [
    {
        label: 'team with identical name/brokerage',
        segments: ['TEAM', '5.0', '(5,478)', '8z Real Estate', '8z Real Estate', '$18K - $11M', 'team price range', '1,010', 'team sales last 12 months', '33', 'team sales in Mead'],
        expect: {
            Name: '8z Real Estate', Brokerage: '8z Real Estate', 'Team Name': '8z Real Estate',
            Rating: '5.0', 'Review Count': '5478', 'Average Sales Volume': '$18K - $11M',
            'Sales Count Last Year': '1010', 'Local Sales Count': '33',
        },
    },
    {
        label: 'team with DIFFERENT name and brokerage (the bug we fixed)',
        segments: ['TEAM', '5.0', '(224)', 'Integrity Home Group', 'eXp Realty', '$15K - $995K', 'team price range', '9', 'team sales last 12 months', '11', 'team sales in Mead'],
        expect: {
            Name: 'Integrity Home Group', Brokerage: 'eXp Realty', 'Team Name': 'Integrity Home Group',
            Rating: '5.0', 'Review Count': '224', 'Average Sales Volume': '$15K - $995K',
            'Sales Count Last Year': '9', 'Local Sales Count': '11',
        },
    },
    {
        label: 'team led by a person name',
        segments: ['TEAM', '5.0', '(377)', 'Ben Woodrum', 'Coldwell Banker Realty', '$67K - $2.2M', 'team price range', '332', 'team sales last 12 months', '3', 'team sales in Mead'],
        expect: {
            Name: 'Ben Woodrum', Brokerage: 'Coldwell Banker Realty', 'Team Name': 'Ben Woodrum',
            'Sales Count Last Year': '332', 'Local Sales Count': '3',
        },
    },
    {
        label: 'individual with full data',
        segments: ['Dina Young', '5.0', '(39)', 'Resident Realty', '$220K - $1.6M', 'price range', '14', 'sales last 12 months', '63', 'sales in Mead'],
        expect: {
            Name: 'Dina Young', Brokerage: 'Resident Realty', 'Team Name': '',
            Rating: '5.0', 'Review Count': '39', 'Average Sales Volume': '$220K - $1.6M',
            'Sales Count Last Year': '14', 'Local Sales Count': '63',
        },
    },
    {
        label: 'individual, no price + no sales last year + singular local sale',
        segments: ['Yvette teVelde', '5.0', '(9)', 'RE/MAX Momentum Westminster', 'No recent price range', 'No sales last 12 months', '1', 'sale in Mead'],
        expect: {
            Name: 'Yvette teVelde', Brokerage: 'RE/MAX Momentum Westminster',
            'Average Sales Volume': '', 'Sales Count Last Year': '0', 'Local Sales Count': '1',
        },
    },
    {
        label: 'individual, no local sales',
        segments: ['Lou Scirrotto', '5.0', '(170)', 'Real', '$400K - $1.4M', 'price range', '2', 'sales last 12 months', 'No sales in Mead'],
        expect: {
            Name: 'Lou Scirrotto', Brokerage: 'Real', 'Average Sales Volume': '$400K - $1.4M',
            'Sales Count Last Year': '2', 'Local Sales Count': '0',
        },
    },
    {
        label: 'individual whose name contains the brokerage',
        segments: ['Ashley Bevan - The Mint Group brokered by eXp Realty', '5.0', '(32)', 'The Mint Group brokered by eXp Realty', '$399K - $1.5M', 'price range', '11', 'sales last 12 months', '24', 'sales in Mead'],
        expect: {
            Name: 'Ashley Bevan - The Mint Group brokered by eXp Realty',
            Brokerage: 'The Mint Group brokered by eXp Realty',
            'Sales Count Last Year': '11', 'Local Sales Count': '24',
        },
    },
];

for (const { label, segments, expect } of SEGMENT_CASES) {
    test(`segments: ${label}`, () => {
        const agent = parseAgentSegments(segments, 'https://www.zillow.com/profile/test/', mead);
        assert.ok(agent, 'parseAgentSegments returned null');
        for (const [key, val] of Object.entries(expect)) {
            assert.equal(agent[key], val, `field "${key}"`);
        }
    });
}

test('Top Agent badge is detected and stripped from name', () => {
    const agent = parseAgentText(
        'Jane Doe Top Agent5.0 (10)Acme Realty$100K - $500K price range3 sales last 12 months1 sales in Mead',
        'https://www.zillow.com/profile/jane/',
        mead,
    );
    assert.equal(agent['Top Agent on Zillow'], 'Yes');
    assert.equal(agent['Name'], 'Jane Doe');
});
