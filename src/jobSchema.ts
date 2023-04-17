import mongoose, { Types } from 'mongoose';

export interface IJob {
    _id: Types.ObjectId;
    name: string;
    data: any;
    intervalStr: string;
    interval: number;
    status: string;
    nextRunAt: Date;
    errCounter: number;
    lastError: string;
}

function getSchema(collection: string): mongoose.Schema<IJob> {
    const schema = new mongoose.Schema<IJob>(
        {
            name: { type: String, index: true },
            data: { type: Object, default: {} },
            intervalStr: String,
            interval: Number,
            status: { type: String, index: true },
            nextRunAt: Date,
            errCounter: Number,
            lastError: String,
        },
        { collection, minimize: false },
    );
    return schema;
}

export default getSchema;
