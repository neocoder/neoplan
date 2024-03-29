# Neoplan

Neoplan is a lightweight MongoDB based Node.js job scheduler inspired by Agenda.

Neoplan is different to Agenda in several aspects: its not that feature rich and it allows to schedule jobs with the same name but different data parameters.

# Installation

Install via NPM

    npm install neoplan

You will also need a working [mongo](http://www.mongodb.org/) database (2.4+) to point it to.

# Changes

    - v1.1.1 - Breaking change. .connect() method needs to be called after instance creation.

# Example Usage

```js
var neoplan = new Neoplan({ db: { address: 'localhost:27017/neoplan-example' } });

neoplan.connect();

neoplan.define('delete old users', function (data, done) {
    User.remove({ lastLogIn: { $lt: twoDaysAgo } }, done);
});

neoplan.every('3 minutes', 'delete old users');

// Alternatively, you could also do:

neoplan.every('*/3 * * * *', 'delete old users');
```

```js
neoplan.define('send email report', { priority: 'high', concurrency: 10 }, function (job, done) {
    var data = job.attrs.data;
    emailClient.send(
        {
            to: data.to,
            from: 'example@example.com',
            subject: 'Email Report',
            body: '...',
        },
        done,
    );
});

neoplan.schedule('in 20 minutes', 'send email report', { to: 'admin@example.com' });
```

```js
var weeklyReport = neoplan.schedule('Saturday at noon', 'send email report', {
    to: 'another-guy@example.com',
});
weeklyReport.repeatEvery('1 week').save();
```

# Full documentation

Neoplan's basic control structure is an instance of an neoplan. Neoplan's are
mapped to a database collection and load the jobs from within.

## Table of Contents

-   [Configuring an neoplan](#configuring-an-neoplan)
-   [Defining job processors](#defining-job-processors)
-   [Creating jobs](#creating-jobs)
-   [Managing jobs](#managing-jobs)
-   [Starting the job processor](#starting-the-job-processor)
-   [Multiple job processors](#multiple-job-processors)
-   [Manually working with jobs](#manually-working-with-a-job)
-   [Job Queue Events](#job-queue-events)
-   [Frequently asked questions](#frequently-asked-questions)

## Configuring an neoplan

All configuration methods are chainable, meaning you can do something like:

```js
var neoplan = new Neoplan();
neoplan
  .database(...)
  .processEvery('3 minutes')
  ...;
```

### database(url, [collectionName])

Specifies the database at the `url` specified. If no collection name is give,
`jobs` is used.

```js
neoplan.database('localhost:27017/neoplan-test', 'jobs');
```

You can also specify it during instantiation.

```js
var neoplan = new Neoplan({ db: { address: 'localhost:27017/neoplan-test', collection: 'jobs' } });
```

### mongo(mongoSkinInstance)

Use an existing mongoskin instance. This can help consolidate connections to a
database. You can instead use `.database` to have neoplan handle connecting for
you.

You can also specify it during instantiation.

```js
var neoplan = new Neoplan({ mongo: mongoSkinInstance });
```

### name(name)

Takes a string `name` and sets `lastModifiedBy` to it in the job database.
Useful for if you have multiple job processors and want to see which
job queue last ran the job.

```js
neoplan.name(os.hostname + '-' + process.pid);
```

You can also specify it during instantiation

```js
var neoplan = new Neoplan({ name: 'test queue' });
```

### processEvery(interval)

Takes a string `interval` which can be either a traditional javascript number,
or a string such as `3 minutes`

Specifies the frequency at which neoplan will query the database looking for jobs
that need to be processed. Neoplan internally uses `setTimeout` to guarantee that
jobs run at (close to ~3ms) the right time.

Decreasing the frequency will result in fewer database queries, but more jobs
being stored in memory.

Also worth noting is that if the job is queue is shutdown, any jobs stored in memory
that haven't run will still be locked, meaning that you may have to wait for the
lock to expire.

```js
neoplan.processEvery('1 minute');
```

You can also specify it during instantiation

```js
var neoplan = new Neoplan({ processEvery: '30 seconds' });
```

### maxConcurrency(number)

Takes a `number` which specifies the max number of jobs that can be running at
any given moment. By default it is `20`.

```js
neoplan.maxConcurrency(20);
```

You can also specify it during instantiation

```js
var neoplan = new Neoplan({ maxConcurrency: 20 });
```

### defaultConcurrency(number)

Takes a `number` which specifies the default number of a specific that can be running at
any given moment. By default it is `5`.

```js
neoplan.defaultConcurrency(5);
```

You can also specify it during instantiation

```js
var neoplan = new Neoplan({ defaultConcurrency: 5 });
```

### defaultLockLifetime(number)

Takes a `number` which specifies the default lock lifetime in milliseconds. By
default it is 10 minutes. This can be overridden by specifying the
`lockLifetime` option to a defined job.

A job will unlock if it is finished (ie. `done` is called) before the `lockLifetime`.
The lock is useful if the job crashes or times out.

```js
neoplan.defaultLockLifetime(10000);
```

You can also specify it during instantiation

```js
var neoplan = new Neoplan({ defaultLockLifetime: 10000 });
```

## Defining Job Processors

Before you can use a job, you must define its processing behavior.

### define(jobName, [options], fn)

Defines a job with the name of `jobName`. When a job of job name gets run, it
will be passed to `fn(job, done)`. To maintain asynchronous behavior, you must
call `done()` when you are processing the job. If your function is synchronous,
you may omit `done` from the signature.

`options` is an optional argument which can overwrite the defaults. It can take
the following:

-   `concurrency`: `number` maxinum number of that job that can be running at once (per instance of neoplan)
-   `lockLifetime`: `number` interval in ms of how long the job stays locked for (see [multiple job processors](#multiple-job-processors) for more info).
    A job will automatically unlock if `done()` is called.
-   `priority`: `(lowest|low|normal|high|highest|number)` specifies the priority
    of the job. Higher priority jobs will run first. See the priority mapping
    below

Priority mapping:

```
{
  highest: 20,
  high: 10,
  default: 0,
  low: -10,
  lowest: -20
}
```

Async Job:

```js
neoplan.define('some long running job', function (job, done) {
    doSomelengthyTask(function (data) {
        formatThatData(data);
        sendThatData(data);
        done();
    });
});
```

Sync Job:

```js
neoplan.define('say hello', function (job) {
    console.log('Hello!');
});
```

## Creating Jobs

### every(interval, name, [data])

Runs job `name` at the given `interval`. Optionally, data can be passed in.
Every creates a job of type `single`, which means that it will only create one
job in the database, even if that line is run multiple times. This lets you put
it in a file that may get run multiple times, such as `webserver.js` which may
reboot from time to time.

`interval` can be a human-readable format `String`, a cron format `String`, or a `Number`.

`data` is an optional argument that will be passed to the processing function
under `job.attrs.data`.

Returns the `job`.

```js
neoplan.define('printAnalyticsReport', function (job, done) {
    User.doSomethingReallyIntensive(function (err, users) {
        processUserData();
        console.log('I print a report!');
        done();
    });
});

neoplan.every('15 minutes', 'printAnalyticsReport');
```

Optionally, `name` could be array of job names, which is convenient for scheduling
different jobs for same `interval`.

```js
neoplan.every('15 minutes', ['printAnalyticsReport', 'sendNotifications', 'updateUserRecords']);
```

In this case, `every` returns array of `jobs`.

### schedule(when, name, data)

Schedules a job to run `name` once at a given time. `when` can be a `Date` or a
`String` such as `tomorrow at 5pm`.

`data` is an optional argument that will be passed to the processing function
under `job.data`.

Returns the `job`.

```js
neoplan.schedule('tomorrow at noon', 'printAnalyticsReport', { userCount: 100 });
```

Optionally, `name` could be array of job names, similar to `every` method.

```js
neoplan.schedule('tomorrow at noon', [
    'printAnalyticsReport',
    'sendNotifications',
    'updateUserRecords',
]);
```

In this case, `schedule` returns array of `jobs`.

### now(name, data)

Schedules a job to run `name` once immediately.

`data` is an optional argument that will be passed to the processing function
under `job.data`.

Returns the `job`.

```js
neoplan.now('do the hokey pokey');
```

### create(jobName, data)

Returns an instance of a `jobName` with `data`. This does _NOT_ save the job in
the database. See below to learn how to manually work with jobs.

```js
var job = neoplan.create('printAnalyticsReport', { userCount: 100 });
job.save(function (err) {
    console.log('Job successfully saved');
});
```

## Managing Jobs

### jobs(mongoskin query)

Lets you query all of the jobs in the neoplan job's database. This is a full [mongoskin](https://github.com/kissjs/node-mongoskin)
`find` query. See mongoskin's documentation for details.

```js
neoplan.jobs({ name: 'printAnalyticsReport' }, function (err, jobs) {
    // Work with jobs (see below)
});
```

### cancel(mongoskin query, cb)

Cancels any jobs matching the passed mongoskin query, and removes them from the database.

```js
neoplan.cancel({ name: 'printAnalyticsReport' }, function (err, numRemoved) {});
```

This functionality can also be achieved by first retrieving all the jobs from the database using `neoplan.jobs()`, looping through the resulting array and calling `job.remove()` on each. It is however preferable to use `neoplan.cancel()` for this use case, as this ensures the operation is atomic.

### purge(cb)

Removes all jobs in the database without defined behaviors. Useful if you change a definition name and want to remove old jobs.

_IMPORTANT:_ Do not run this before you finish defining all of your jobs. If you do, you will nuke your database of jobs.

```js
neoplan.purge(function (err, numRemoved) {});
```

## Starting the job processor

To get neoplan to start processing jobs from the database you must start it. This
will schedule an interval (based on `processEvery`) to check for new jobs and
run them. You can also stop the queue.

### start

Starts the job queue processing, checking `processEvery` time to see if there
are new jobs.

### stop

Stops the job queue processing. Unlocks currently running jobs.

This can be very useful for graceful shutdowns so that currently running/grabbed jobs are abandoned so that other
job queues can grab them / they are unlocked should the job queue start again. Here is an example of how to do a graceful
shutdown.

```js
function graceful() {
    neoplan.stop(function () {
        process.exit(0);
    });
}

process.on('SIGTERM', graceful);
process.on('SIGINT', graceful);
```

## Multiple job processors

Sometimes you may want to have multiple node instances / machines process from
the same queue. Neoplan supports a locking mechanism to ensure that multiple
queues don't process the same job.

You can configure the locking mechanism by specifying `lockLifetime` as an
interval when defining the job.

```js
neoplan.define('someJob', { lockLifetime: 10000 }, function (job, cb) {
    //Do something in 10 seconds or less...
});
```

This will ensure that no other job processor (this one included) attempts to run the job again
for the next 10 seconds. If you have a particularly long running job, you will want to
specify a longer lockLifetime.

By default it is 10 minutes. Typically you shouldn't have a job that runs for 10 minutes,
so this is really insurance should the job queue crash before the job is unlocked.

When a job is finished (ie. `done` is called), it will automatically unlock.

## Manually working with a job

A job instance has many instance methods. All mutating methods must be followed
with a call to `job.save()` in order to persist the changes to the database.

### repeatEvery(interval)

Specifies an `interval` on which the job should repeat.

`interval` can be a human-readable format `String`, a cron format `String`, or a `Number`.

```js
job.repeatEvery('10 minutes');
job.save();
```

### schedule(time)

Specifies the next `time` at which the job should repeat.

```js
job.schedule('tomorrow at 6pm');
job.save();
```

### priority(priority)

Specifies the `priority` weighting of the job. Can be a number or a string from
the above priority table.

```js
job.priority('low');
job.save();
```

### fail(reason)

Sets `job.attrs.failedAt` to `now`, and sets `job.attrs.failReason`
to `reason`.

Optionally, `reason` can be an error, in which case `job.attrs.failReason` will
be set to `error.message`

```js
job.fail('insuficient disk space');
// or
job.fail(new Error('insufficient disk space'));
job.save();
```

### run(callback)

Runs the given `job` and calls `callback(err, job)` upon completion. Normally
you never need to call this manually.

```js
job.run(function (err, job) {
    console.log("I don't know why you would need to do this...");
});
```

### save(callback)

Saves the `job.attrs` into the database.

```js
job.save(function (err) {
    if (!err) console.log('Successfully saved job to collection');
});
```

### remove(callback)

Removes the `job` from the database.

```js
job.remove(function (err) {
    if (!err) console.log('Successfully removed job from collection');
});
```

### touch(callback)

Resets the lock on the job. Useful to indicate that the job hasn't timed out
when you have very long running jobs.

```js
neoplan.define('super long job', function (job, done) {
    doSomeLongTask(function () {
        job.touch(function () {
            doAnotherLongTask(function () {
                job.touch(function () {
                    finishOurLongTasks(done);
                });
            });
        });
    });
});
```

## Job Queue Events

An instance of an neoplan will emit the following events:

-   `start` - called just before a job starts
-   `start:job name` - called just before the specified job starts

```js
neoplan.on('start', function (job) {
    console.log('Job %s starting', job.attrs.name);
});
```

-   `complete` - called when a job finishes, regardless of if it succeeds or fails
-   `complete:job name` - called when a job finishes, regardless of if it succeeds or fails

```js
neoplan.on('complete', function (job) {
    console.log('Job %s finished', job.attrs.name);
});
```

-   `success` - called when a job finishes successfully
-   `success:job name` - called when a job finishes successfully

```js
neoplan.once('success:send email', function (job) {
    console.log('Sent Email Successfully to: %s', job.attrs.data.to);
});
```

-   `fail` - called when a job throws an error
-   `fail:job name` - called when a job throws an error

```js
neoplan.on('fail:send email', function (err, job) {
    console.log('Job failed with error: %s', err.message);
});
```

## Frequently Asked Questions

### Web Interface?

Neoplan itself does not have a web interface built in. That being said, there is a stand-alone web interface in the form of [neoplan-ui](https://github.com/moudy/neoplan-ui).

Screenshot:

![neoplan-ui interface](https://raw.githubusercontent.com/moudy/neoplan-ui/screenshot/neoplan-ui-screenshot.png)

### Mongo vs Redis

The decision to use Mongo instead of Redis is intentional. Redis is often used for
non-essential data (such as sessions) and without configuration doesn't
guarantee the same level of persistence as Mongo (should the server need to be
restarted/crash).

Neoplan decides to focus on persistence without requiring special configuration
of Redis (thereby degrading the performance of the Redis server on non-critical
data, such as sessions).

Ultimately if enough people want a Redis driver instead of Mongo, I will write
one. (Please open an issue requesting it). For now, Neoplan decided to focus on
guaranteed persistence.

### Spawning / forking processes.

Ultimately Neoplan can work from a single job queue across multiple machines, node processes, or forks. If you are interested in having more than one worker, [Bars3s](http://github.com/bars3s) has written up a fantastic example of how one might do it:

```js
var cluster = require('cluster'),
    cpuCount = require('os').cpus().length,
    jobWorkers = [],
    webWorkers = [];

if (cluster.isMaster) {
    // Create a worker for each CPU
    for (var i = 0; i < cpuCount; i += 1) {
        addJobWorker();
        addWebWorker();
    }

    cluster.on('exit', function (worker, code, signal) {
        if (jobWorkers.indexOf(worker.id) != -1) {
            console.log('job worker ' + worker.process.pid + ' died. Trying to respawn...');
            removeJobWorker(worker.id);
            addJobWorker();
        }

        if (webWorkers.indexOf(worker.id) != -1) {
            console.log('http worker ' + worker.process.pid + ' died. Trying to respawn...');
            removeWebWorker(worker.id);
            addWebWorker();
        }
    });
} else {
    if (process.env.web) {
        console.log('start http server: ' + cluster.worker.id);
        require('./app/web-http'); //initialize the http server here
    }

    if (process.env.job) {
        console.log('start job server: ' + cluster.worker.id);
        require('./app/job-worker'); //initialize the neoplan here
    }
}

function addWebWorker() {
    webWorkers.push(cluster.fork({ web: 1 }).id);
}

function addJobWorker() {
    jobWorkers.push(cluster.fork({ job: 1 }).id);
}

function removeWebWorker(id) {
    webWorkers.splice(webWorkers.indexOf(id), 1);
}

function removeJobWorker(id) {
    jobWorkers.splice(jobWorkers.indexOf(id), 1);
}
```

# License

(The MIT License)

Copyright (c) 2013 Ryan Schmukler <ryan@slingingcode.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the 'Software'), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
