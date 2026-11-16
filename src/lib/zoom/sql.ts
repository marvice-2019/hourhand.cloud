// SQL shared by the booking queue and the job worker. No imports, so the data layer can use it without pulling in Zoom.

/** True when new Zoom bookings for this host can get a link: connected, with stored tokens. */
export const ZOOM_READY_SQL = (userIdExpr: string) =>
  `exists (select 1 from integrations zi where zi.user_id = ${userIdExpr} and zi.provider = 'zoom' and zi.status = 'ok' and octet_length(zi.credentials_encrypted) > 0)`;
