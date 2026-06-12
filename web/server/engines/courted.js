// engines/courted.js — bridge the Courted scraper into a streaming job.
// Pure HTTP, fast: results land in seconds.

import { runScrape } from '../../../courted/src/scraper.js';
import { emit, engineFinished } from '../jobs.js';

export async function runCourted(job) {
    const { locations, courtedMax, courtedEnrich, minSalesVolume } = job.params;
    const source = 'courted';

    const email = process.env.COURTED_EMAIL;
    const password = process.env.COURTED_PASSWORD;
    if (!email || !password) {
        emit(job, 'source_error', { source, message: 'Courted credentials not set (COURTED_EMAIL / COURTED_PASSWORD in web/.env).' });
        engineFinished(job);
        return;
    }

    emit(job, 'progress', { source, status: 'running', message: 'Signing in…' });

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        debug: () => {},
    };

    let total = 0; // sum of matched counts across all searched locations
    try {
        const { pushed } = await runScrape(
            {
                email,
                password,
                locations,
                maxRecords: courtedMax || 0,
                maxRecordsPerLocation: 0,
                minSalesVolume: minSalesVolume || 0,
                enrichProfiles: Boolean(courtedEnrich),
            },
            {
                log,
                onRecord: (row) => emit(job, 'record', { source, row }),
                onMeta: ({ total: t }) => {
                    total += t || 0;
                    emit(job, 'meta', { source, total });
                },
            },
        );
        const capped = courtedMax && total > courtedMax;
        emit(job, 'source_done', {
            source,
            message: capped
                ? `${pushed} of ${total.toLocaleString()} (capped at ${courtedMax})`
                : `${pushed} agents`,
        });
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        engineFinished(job);
    }
}
