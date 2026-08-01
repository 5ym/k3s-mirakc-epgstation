import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { reserve } from '$lib/server/reservations';
import type { Program, Service } from '$lib/types';

const WINDOW = 24 * 60 * 60 * 1000;

interface Row extends Program {
    service_name: string;
    reservation_id: number | null;
    reservation_state: string | null;
}

export async function load({ url }) {
    const services = db.prepare('SELECT * FROM services ORDER BY type, channel').all() as Service[];
    const serviceId = Number(url.searchParams.get('service') ?? '') || null;
    const keyword = (url.searchParams.get('q') ?? '').trim();

    const at = Date.now();
    const params: (string | number)[] = [at, at + WINDOW];
    let where = 'p.end_at > ? AND p.start_at < ?';
    if (serviceId !== null) {
        where += ' AND p.service_id = ?';
        params.push(serviceId);
    }
    if (keyword !== '') {
        where += ' AND (p.name LIKE ? OR p.description LIKE ?)';
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const programs = db
        .prepare(
            `SELECT p.*, s.name AS service_name, r.id AS reservation_id, r.state AS reservation_state
             FROM programs p
             JOIN services s ON s.id = p.service_id
             LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
             WHERE ${where}
             ORDER BY p.start_at, s.channel
             LIMIT 400`,
        )
        .all(...params) as Row[];

    return { services, programs, serviceId, keyword };
}

export const actions = {
    reserve: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        try {
            await reserve(programId, { encode: form.get('encode') !== 'off' });
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },
};
