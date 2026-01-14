document.addEventListener('DOMContentLoaded', () => {
    // --- Element Selectors ---
    const burgerMenu = document.querySelector('.burger-menu');
    const mainNav = document.querySelector('.main-nav');
    const langToggle = document.querySelector('.nav-lang-toggle');
    const yearSpan = document.getElementById('year');

    // --- Language Toggle Functionality ---
    if (langToggle) {
        function setLanguage(lang) {
            localStorage.setItem('prokaiwaLang', lang);

            const isJapanese = lang === 'ja';
            document.documentElement.lang = lang;

            const allLangElements = document.body.querySelectorAll('[lang="ja"], [lang="en"]');
            allLangElements.forEach(el => {
                if (el.closest('.nav-lang-toggle')) return;

                if (el.getAttribute('lang') === lang) {
                    el.style.display = '';
                    if (el.classList.contains('lang-section')) {
                        el.classList.add('show');
                    }
                } else {
                    el.style.display = 'none';
                    if (el.classList.contains('lang-section')) {
                        el.classList.remove('show');
                    }
                }
            });

            langToggle.querySelector('[data-lang="ja"]').classList.toggle('active', isJapanese);
            langToggle.querySelector('[data-lang="en"]').classList.toggle('active', !isJapanese);
        }

        langToggle.addEventListener('click', event => {
            const button = event.target.closest('button[data-lang]');
            if (button) {
                setLanguage(button.dataset.lang);
            }
        });

        const savedLang = localStorage.getItem('prokaiwaLang');
        if (savedLang) {
            setLanguage(savedLang);
        } else {
            const userLang = (navigator.language || navigator.userLanguage).split('-')[0];
            setLanguage(userLang === 'ja' ? 'ja' : 'en');
        }
    }

    // --- Burger Menu Functionality ---
    if (burgerMenu) {
        burgerMenu.addEventListener('click', () => {
            mainNav.classList.toggle('open');
            burgerMenu.querySelector('i').classList.toggle('fa-bars');
            burgerMenu.querySelector('i').classList.toggle('fa-times');
        });
    }
    
    // --- Footer Year ---
    if (yearSpan) {
        yearSpan.textContent = new Date().getFullYear();
    }

    // --- NEW: FAQ Accordion Logic ---
    const faqQuestions = document.querySelectorAll('.faq-question');
    if (faqQuestions.length > 0) {
        faqQuestions.forEach(question => {
            question.addEventListener('click', () => {
                const answer = question.nextElementSibling;
                const wasOpen = answer.classList.contains('open');

                // Close all other answers
                document.querySelectorAll('.faq-answer').forEach(ans => {
                    ans.style.maxHeight = null;
                    ans.classList.remove('open');
                });
                
                // If the clicked one wasn't already open, open it
                if (!wasOpen) {
                    answer.classList.add('open');
                    answer.style.maxHeight = (answer.scrollHeight + 40) + 'px';
                }
            });
        });
    }
});