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

import parseRange from 'range-parser';

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

		const url = new URL(request.url);
		const pathname = url.pathname.slice(1).split('/').filter(Boolean);

		if (pathname[0] === 'robots.txt') {
			return new Response('User-agent: *\nDisallow: /\n', {
				headers: {
					'Content-Type': 'text/plain; charset=utf-8',
				},
			});
		}

		const {
			BUCKET_SUFFIX: bucketSuffix,
			OWNER: owner,
			FAVICON: favicon,
			CHUNK_SIZE: chunkSize,
			SECURITY_CONTACT: securityContact,
			SECURITY_EXPIRES: securityExpires,
		} = env;

		if (pathname[0] === '.well-known' && pathname[1] === 'security.txt') {
			return new Response(`Contact: ${securityContact}\nExpires: ${securityExpires}\n`, {
				headers: {
					'Content-Type': 'text/plain; charset=utf-8',
				},
			});
		}

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
					'<p>Powered by <a href="https://github.com/Moroshima/sasebo" target="_blank">Sasebo</a></p>' +
					'</body>' +
					'</html>',
				{
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
					},
				}
			);
		}

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
			const metadata = await bucket.binding.head(key);
			if (metadata === null) return new Response('Object Not Found', { status: 404 });

			const range = request.headers.has('Range') ? parseRange(metadata.size, request.headers.get('Range') as string) : undefined;

			const headers = new Headers();

			let offset = 0,
				length;

			if (range === -1) {
				return new Response('Malformed Header String', { status: 400 });
			} else if (range === -2) {
				return new Response('Range Not Satisfiable', { status: 416 });
			} else if (range !== undefined) {
				if (range.type === 'bytes') {
					const start = range[0].start;
					let end = range[0].end;
					if (end - start > chunkSize - 1) {
						end = start + chunkSize - 1;
					}
					offset = start;
					length = end - start + 1; // end minus start can't be negative here
					headers.set('Content-Range', ['bytes'].concat(`${start}-${end}/${metadata.size}`).join(' '));
				}
			} // else if range is undefined, do nothing

			// Has range request, but zero bytes to return is invalid
			if (range !== undefined && length === undefined) return new Response('Range Not Satisfiable', { status: 416 });

			const ifNoneMatch = request.headers.get('If-None-Match');
			if (ifNoneMatch !== null) {
				const list = ifNoneMatch.split(',').map((value) => {
					return value.trim().startsWith('W/') ? value.trim().slice(2) : value.trim();
				});

				if (list.includes(metadata.httpEtag)) {
					return new Response(undefined, {
						status: 304,
						headers: {
							ETag: metadata.httpEtag,
						},
					});
				}
			}

			const object = await bucket.binding.get(key, {
				onlyIf: request.headers,
				range: range ? { offset: offset, length: length } : undefined,
			});
			if (object === null) return new Response('Failed to Get Object', { status: 500 });

			// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#http-metadata
			object.writeHttpMetadata(headers);

			headers.set('ETag', object.httpEtag);
			headers.set('Accept-Ranges', 'bytes'); // unnecessary, but can tell the client that we accept range requests

			let status = 200;
			if (!('body' in object)) {
				status = 412; // When no body is present, preconditions have failed
			} else if (range !== undefined) {
				status = 206;
			}

			return new Response('body' in object ? object.body : undefined, {
				status,
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
