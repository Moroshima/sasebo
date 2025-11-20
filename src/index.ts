/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `pnpm dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `pnpm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method !== 'GET') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: 'GET',
				},
			});
		}

		const { BUCKET_SUFFIX: bucketSuffix, OWNER: owner, FAVICON: favicon } = env;

		// Automatically detect r2 buckets by suffix
		const buckets = Object.entries(env)
			.filter(([key]) => key.endsWith(bucketSuffix))
			.map(([key, value]) => ({
				name: key.slice(0, -bucketSuffix.length).toLowerCase().replace('_', '-'),
				binding: value as R2Bucket,
			}));

		function html(body: string, title?: string) {
			return new Response(
				'<!doctype html>' +
					'<html lang="en-US">' +
					'<head>' +
					'<meta charset="utf-8" />' +
					'<meta name="viewport" content="width=device-width" />' +
					`<link rel="icon" href="${favicon}" />` +
					`<title>${title}</title>` +
					'</head>' +
					'<body>' +
					body +
					'</body>' +
					'</html>',
				{
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
					},
				}
			);
		}

		const url = new URL(request.url);
		const pathname = url.pathname.slice(1).split('/').filter(Boolean);

		if (pathname.length === 0) {
			return html(
				'<h1>R2 Buckets</h1>' +
					'<ul>' +
					buckets
						.sort((a, b) => a.name.localeCompare(b.name, 'en'))
						.map(({ name }) => {
							return `<li><a href="${name.concat('/')}">${name}</a></li>`;
						})
						.join('') +
					'</ul>',
				`${owner}'s R2 Index`
			);
		}

		const bucket = buckets.find(({ name }) => name === pathname[0]);

		if (!bucket) {
			return new Response('Bucket Not Found', { status: 404 });
		}

		const path = pathname.slice(1);
		const prefixPath = path.length === 0 ? '' : decodeURI(path.join('/').concat('/'));

		const { objects, delimitedPrefixes } = await bucket.binding.list({
			prefix: prefixPath,
			delimiter: '/',
		});

		const key = decodeURI(path.join('/'));

		const debug = url.searchParams.get('debug') === '1' ? true : false;

		// When the path resolves to a direct R2 object (no prefixes/objects), return the file with metadata and range support
		if (delimitedPrefixes.length === 0 && objects.length === 0 && path.length !== 0 && !debug) {
			const object = await bucket.binding.get(key, {
				onlyIf: request.headers,
				range: request.headers,
			});

			if (object === null) return new Response('Object Not Found', { status: 404 });

			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('ETag', object.httpEtag);
			headers.set('Accept-Ranges', 'bytes'); // unnecessary, but can tell the client that we accept range requests

			// When no body is present, preconditions have failed
			return new Response('body' in object ? object.body : undefined, {
				status: 'body' in object ? 200 : 412,
				headers,
			});
		}

		return html(
			`<h1>Index of /${bucket.name}/${!prefixPath ? '' : prefixPath}</h1>` +
				(debug
					? '<details>' +
					  '<summary>Debug</summary>' +
					  `<p>url: ${JSON.stringify(url)}</p>` +
					  `<p>pathname: ${JSON.stringify(pathname)}</p>` +
					  `<p>path(array): ${decodeURI(JSON.stringify(path))}</p>` +
					  `<p>path(string): ${JSON.stringify(prefixPath)}</p>` +
					  `<p>dirs: ${JSON.stringify(delimitedPrefixes)}</p>` +
					  `<p>files: ${JSON.stringify(objects)}</p>` +
					  '</details>'
					: '') +
				'<ul>' +
				'<li><a href="..">Parent directory/</a></li>' +
				delimitedPrefixes
					.sort((a, b) => a.localeCompare(b, 'en'))
					.map((element: string) => {
						return `<li><a href="${'/' + pathname[0].concat('/') + element}">${element.slice(prefixPath.length)}</a></li>`;
					})
					.join('') +
				objects
					.sort((a, b) => a.key.localeCompare(b.key, 'en'))
					.map((element: { key: string }) => {
						return `<li><a download href="${'/' + pathname[0].concat('/') + element.key}">${element.key.slice(prefixPath.length)}</a></li>`;
					})
					.join('') +
				'</ul>',
			`Index of /${bucket.name}/${!prefixPath ? '' : prefixPath} | ${owner}'s R2 Index`
		);
	},
} satisfies ExportedHandler<Env>;
