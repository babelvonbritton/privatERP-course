import "./globals.css";

/** Shown for any address that does not exist. */
export default function NotFound() {
  return (
    <html lang="en">
      <body>
        <main className="grid min-h-dvh place-items-center px-6 text-center">
          <div>
            <p className="text-5xl font-semibold text-plum-900">404</p>
            <a href="/" className="mt-4 inline-block text-plum-600 underline underline-offset-4">Olaseena</a>
          </div>
        </main>
      </body>
    </html>
  );
}
