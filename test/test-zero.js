const { expect } = require('chai');
const mongoose = require('mongoose');

const { Neoplan: Jobs } = require('../dist/neoplan');

const JOBS_COLLECTION_NAME = 'jobs-test';
const mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/neoplan';
const opts = { url: mongoPath };

describe('Testing jobs creation', function testingJobs() {
    this.timeout(0);

    it('should fail on defining mongoose mondels for jobs collection', (done) => {
        expect(() => {
            const schema = new mongoose.Schema(
                {
                    name: { type: String, index: true },
                    data: mongoose.Schema.Types.Mixed,
                    intervalStr: String,
                    interval: Number,
                    status: { type: String, index: true },
                    nextRunAt: Date,
                    errCounter: Number,
                    lastError: String,
                },
                { collection: JOBS_COLLECTION_NAME },
            );

            mongoose.model('Job', schema);

            // eslint-disable-next-line no-new
            new Jobs({ collection: JOBS_COLLECTION_NAME, ...opts });
        }).to.throw('Cannot overwrite `Job` model once compiled');

        done();
    });

    it('should define two mongoose models with different names for the same collection', (done) => {
        const schema = new mongoose.Schema(
            {
                name: { type: String, index: true },
                data: mongoose.Schema.Types.Mixed,
                intervalStr: String,
                interval: Number,
                status: { type: String, index: true },
                nextRunAt: Date,
                errCounter: Number,
                lastError: String,
            },
            { collection: JOBS_COLLECTION_NAME },
        );

        mongoose.model('RawJob', schema);

        // eslint-disable-next-line no-new
        new Jobs({ collection: JOBS_COLLECTION_NAME, modelName: 'Job', ...opts });

        done();
    });
});
