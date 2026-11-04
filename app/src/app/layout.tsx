import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Newsreader } from 'next/font/google';
import './globals.css';

const serif = Newsreader({ subsets: ['latin'], variable: '--font-serif', style: ['normal', 'italic'], axes: ['opsz'] });
const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Company Memory',
  description: 'What was decided, what each agent did, where it drifted, and whether the correction survived a fresh run.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a0b0d' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
