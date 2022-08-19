const { expect } = require('chai');
const debug = require('debug')('neoplantest');

const { Neoplan: Jobs } = require('../dist/neoplan');

/*
var iit = it;
it = function(){};
// */

/**
 * scanInterval is defined in this test to make them run faster.
 * Usually you should not change this value
 */

const mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/neoplan';
const opts = { url: mongoPath };
const J = new Jobs({ collection: 'jobs-test', ...opts });

J.on('error', (err) => {
    debug(`[JOBS ERROR] ${err}`);
});

before(async () => J.connect());

after((done) => {
    debug('ALL DONE. CLOSING JOBS CONNECTION');
    J.close();
    done();
});

beforeEach(async () => {
    J._clearJobProcessors();
    await J._dropCollection();
});

describe('Testing jobs', function testingJobs() {
    this.timeout(0);

    // it('should create jobs object and wait for error and reconnection', function(done){
    // 	jobs = new Jobs(_.extend({ collection: 'jobs-test-1' }, opts));
    //
    // 	jobs.on('error', function(err){
    // 		console.log('TEST jobs on error handler: ', err);
    // 	});
    // 	expect(jobs).to.be.an.instanceOf(Jobs);
    // 	//jobs._dropCollection(done);
    // 	//return true;
    // });

    //*

    it('should create jobs object', (done) => {
        expect(J).to.be.an.instanceOf(Jobs);
        done();
    });

    it('should fetch jobs empty batch', async () => {
        const jobsBatch = await J.lockAndGetNextBatch();
        expect(jobsBatch).to.be.instanceOf(Array);
        expect(jobsBatch).to.have.length(0);
    });

    it('should add a single scheduled job', (testDone) => {
        const testId = Date.now();
        J.defineJob('test1', (data, done) => {
            done();
            if (testId === data.testId) {
                testDone();
            }
        });

        J.schedule('in 1 seconds', 'test1', { hello: 'world', testId })
            .then(() => {
                debug('task scheduled');
            })
            .catch((err) => {
                debug(`task scheduling error: ${err.message}`);
            });

        return true;
    });

    it('should scheduled 2 jobs', (testDone) => {
        let x = 0;

        function check() {
            if (x === 2) {
                testDone();
            }
        }

        J.defineJob('test1', (data, done) => {
            x += 1;
            done();
            check();
        });

        J.defineJob('test2', (data, done) => {
            x += 1;
            done();
            check();
        });

        J.schedule('2 seconds', 'test2', { hello: 'world' });
        J.schedule('4 seconds', 'test1', { hello: 'world' });

        return true;
    });

    it('should add a single job, schedule it 10 times and process in 2 batches', (testDone) => {
        // J = new Jobs(_.extend({
        // 	collection: 'jobs-test-5',
        // 	scanInterval: 1000
        // }, opts));

        let x = 0;

        function check() {
            if (x === 10) {
                testDone();
            }
        }

        J.defineJob('test2', (data, done) => {
            debug('job %s executed at %s', data.hello, Date.now());
            debug('test processed! hello %s ', data.hello);
            x += 1;
            done();
            check();
        });

        J.schedule('2 seconds', 'test2', { hello: 'world 1' });
        J.schedule('2 seconds', 'test2', { hello: 'world 2' });
        J.schedule('2 seconds', 'test2', { hello: 'world 3' });
        J.schedule('2 seconds', 'test2', { hello: 'world 4' });
        J.schedule('2 seconds', 'test2', { hello: 'world 5' });
        J.schedule('2 seconds', 'test2', { hello: 'world 6' });
        J.schedule('2 seconds', 'test2', { hello: 'world 7' });
        J.schedule('2 seconds', 'test2', { hello: 'world 8' });
        J.schedule('2 seconds', 'test2', { hello: 'world 9' });
        J.schedule('2 seconds', 'test2', { hello: 'world 10' });

        return true;
    });

    it('should add a single recurring job, and remove it after 5 runs', (testDone) => {
        let x = 0;

        function check() {
            if (x > 3) {
                J.remove('test3', { hello: 'world' });
                setTimeout(() => {
                    expect(x).to.be.equal(4);
                    testDone();
                }, 2000);
            }
        }

        J.defineJob('test3', (data, done) => {
            debug('running TEST job %s time', x);
            x += 1;
            done();
            check();
        });

        J.every('1 seconds', 'test3', { hello: 'world' });

        return true;
    });

    it('should add a single recurring job, schedule and reschedule it for a later time', (testDone) => {
        let x = 0;
        let t;

        function check() {
            expect(x).to.be.equal(1);
            testDone();
        }

        J.defineJob('test4', (data, done) => {
            x += 1;
            debug('running TEST job %s time', x);
            done();
            clearTimeout(t);
            check();
        });

        J.schedule('in 1 seconds', 'test4', { hello: 'world' }, () => {
            J.schedule('in 3 seconds', 'test4', { hello: 'world' }, () => {
                t = setTimeout(check, 4000);
            });
        });

        return true;
    });

    it('should run 10 jobs with 1 resulting in error and continue processing', function (testDone) {
        this.timeout(15000);

        let x = 0;

        function check() {
            debug('check x = %s', x);
            if (x === 10) {
                testDone();
            }
        }

        J.defineJob('test5', (data, done) => {
            x += 1;
            if (data.hello === 'FAIL') {
                done(new Error('FAIL'));
                check();
                return;
            }
            debug('job %s executed at %s', data.hello, Date.now());
            debug('test processed! hello %s ', data.hello);
            done();
            check();
        });

        J.schedule('2 seconds', 'test5', { hello: 'world 1' });
        J.schedule('2 seconds', 'test5', { hello: 'world 2' });
        J.schedule('2 seconds', 'test5', { hello: 'world 3' });
        J.schedule('2 seconds', 'test5', { hello: 'FAIL' });
        J.schedule('2 seconds', 'test5', { hello: 'world 5' });
        J.schedule('2 seconds', 'test5', { hello: 'world 6' });
        J.schedule('2 seconds', 'test5', { hello: 'world 7' });
        J.schedule('2 seconds', 'test5', { hello: 'world 8' });
        J.schedule('2 seconds', 'test5', { hello: 'world 9' });
        J.schedule('2 seconds', 'test5', { hello: 'world 10' });

        return true;
    });

    it('should continue processing after 1 job timed out', function (testDone) {
        this.timeout(45000);

        J.defineJob('test6', (data, done) => {
            debug('Processing %s', data.x);

            if (data.x === 'TIMEOUT') {
                return;
            }

            if (data.x === 'VENUS') {
                testDone();
            }

            done();
        });

        J.schedule('2 seconds', 'test6', { x: 'TIMEOUT' });
        J.schedule('2 seconds', 'test6', { x: 'SUN' });
        J.schedule('2 seconds', 'test6', { x: 'MERCURY' });
        J.schedule('30 seconds', 'test6', { x: 'VENUS' });

        return true;
    });

    it('should run job immediately', function (testDone) {
        this.timeout(45000);

        J.defineJob('test7', (data, done) => {
            done();
            testDone();
        });

        J.now('test7');

        return true;
    });

    it('should adjust job timeout', function (testDone) {
        this.timeout(21000);

        let jobId = null;

        const jobTimeout = 500;

        const check = async () => {
            debug(`looking for job ${jobId}`);
            const doneJob = await J._getJob(jobId);
            expect(doneJob.lastError).to.contain('done after timeout');
        };

        J.defineJob(
            'test-late',
            (data, done) => {
                setTimeout(() => {
                    done();
                    setTimeout(() => {
                        check().then(testDone).catch(testDone);
                    }, 200);
                }, 2000);
            },
            { timeout: jobTimeout },
        );

        J.now('test-late').then((cretedJob) => {
            jobId = cretedJob._id;
        });

        return true;
    });

    it('should run job and re-run done job with the same data ', function (testDone) {
        this.timeout(15000);

        const accId = 'abc123';

        let x = 0;

        function check() {
            debug('check x = %s', x);
            if (x === 1) {
                J.schedule('2 seconds', 'test5', { accId });
            } else if (x === 2) {
                testDone();
            }
        }

        J.defineJob('test5', (data, done) => {
            x += 1;
            done();
            check();
        });

        J.now('test5', { accId });
    });
});
